import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, resourceName } from '../config/environment-config';
import { APP_NAMESPACE, OBSERVABILITY_NAMESPACE } from '../constants';
import { GpuNodeGroup } from '../constructs/gpu-node-group';
import { EksAddons } from '../constructs/eks-addons';
import { FastapiCognitoConfig } from '../constructs/fastapi-workload';
import { Workloads } from './workload-stack';

export { APP_NAMESPACE, OBSERVABILITY_NAMESPACE };

export interface EksStackProps extends StackProps {
  readonly config: PilotEnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly fastApiRepository: ecr.IRepository;
  readonly cognito: FastapiCognitoConfig;
}

/**
 * EKS control plane, CPU + GPU managed node groups, core add-ons, the AWS Load
 * Balancer Controller, application namespaces, and least-privilege access
 * entries. `defaultCapacity` is 0 — all capacity is explicit.
 */
export class EksStack extends Stack {
  public readonly cluster: eks.Cluster;
  public readonly cpuNodeGroup: eks.Nodegroup;
  public readonly gpuNodeGroup: eks.Nodegroup;
  public readonly appNamespaceManifest: Construct;
  public readonly workloads: Workloads;
  public readonly apiBaseUrl: string;

  constructor(scope: Construct, id: string, props: EksStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;

    // Restrict the public API endpoint when CIDRs are supplied; otherwise use
    // public+private access (the private endpoint is always on).
    const endpointAccess =
      config.clusterPublicAccessCidrs.length > 0
        ? eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(...config.clusterPublicAccessCidrs)
        : eks.EndpointAccess.PUBLIC_AND_PRIVATE;

    // Role that will hold cluster-admin via an access entry (platform admins).
    const clusterAdminRole = new iam.Role(this, 'ClusterAdminRole', {
      roleName: resourceName(config, 'cluster-admin'),
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Platform administrator access to the llama-pilot EKS cluster',
    });

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: resourceName(config, 'cluster'),
      version: eks.KubernetesVersion.of(config.kubernetesVersion),
      // kubectl 1.32 layer — within the supported ±1 minor skew of a 1.33 API
      // server (using the matching v33 layer would require aws-cdk-lib ^2.224).
      kubectlLayer: new KubectlV32Layer(this, 'KubectlLayer'),
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0,
      endpointAccess,
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
      mastersRole: clusterAdminRole,
      albController: {
        version: eks.AlbControllerVersion.V2_8_2,
      },
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
        eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
        eks.ClusterLoggingTypes.SCHEDULER,
      ],
    });

    // ---- CPU managed node group (system + FastAPI workloads) ----
    this.cpuNodeGroup = this.cluster.addNodegroupCapacity('CpuNodeGroup', {
      nodegroupName: resourceName(config, 'cpu'),
      instanceTypes: config.cpuNodeInstanceTypes.map((t) => new ec2.InstanceType(t)),
      minSize: 2,
      desiredSize: 2,
      maxSize: 4,
      capacityType: eks.CapacityType.ON_DEMAND,
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      diskSize: config.cpuNodeDiskSizeGiB,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      labels: {
        'workload-type': 'general',
        'node-lifecycle': 'on-demand',
      },
    });

    // ---- GPU managed node group (vLLM only) ----
    this.gpuNodeGroup = new GpuNodeGroup(this, 'Gpu', {
      config,
      cluster: this.cluster,
    }).nodeGroup;

    // ---- Core add-ons + NVIDIA device plugin ----
    new EksAddons(this, 'Addons', { cluster: this.cluster });

    // ---- Namespaces with restricted pod-security labels ----
    this.appNamespaceManifest = this.cluster.addManifest('AppNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: APP_NAMESPACE,
        labels: {
          // Enforce `baseline` (not `restricted`): the vLLM/CUDA container must
          // run as root (runAsNonRoot: false), which `restricted` forbids —
          // admission would reject the vLLM pod and the model would never run.
          // `baseline` still blocks privileged, host namespaces, hostPath, and
          // dangerous capabilities. We keep warn/audit at `restricted` so the
          // (restricted-compliant) FastAPI workload stays clean and any new
          // over-privileged pod is surfaced.
          'pod-security.kubernetes.io/enforce': 'baseline',
          'pod-security.kubernetes.io/warn': 'restricted',
          'pod-security.kubernetes.io/audit': 'restricted',
          'app.kubernetes.io/part-of': 'llama-pilot',
        },
      },
    });
    this.cluster.addManifest('ObservabilityNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: OBSERVABILITY_NAMESPACE,
        labels: {
          'pod-security.kubernetes.io/enforce': 'baseline',
          'app.kubernetes.io/part-of': 'llama-pilot',
        },
      },
    });

    // ---- Least-privilege EKS access entries ----
    // NOTE: `clusterAdminRole` is already granted AmazonEKSClusterAdminPolicy by
    // being the cluster's `mastersRole` (above), which creates its access entry.
    // Do NOT also `grantAccess(...ClusterAdminPolicy)` for the same role — that
    // associates the identical policy twice on one AccessEntry, which
    // CloudFormation early validation rejects (AWS::EarlyValidation::PropertyValidation).

    const cicdRole = new iam.Role(this, 'CicdDeployRole', {
      roleName: resourceName(config, 'cicd-deploy'),
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'CI/CD deployment access (namespace-scoped edit) for llama-pilot',
    });
    this.cluster.grantAccess('CicdAccess', cicdRole.roleArn, [
      eks.AccessPolicy.fromAccessPolicyName('AmazonEKSEditPolicy', {
        accessScopeType: eks.AccessScopeType.NAMESPACE,
        namespaces: [APP_NAMESPACE, OBSERVABILITY_NAMESPACE],
      }),
    ]);

    const readOnlyRole = new iam.Role(this, 'ReadOnlyOperatorRole', {
      roleName: resourceName(config, 'readonly'),
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Read-only operator access for llama-pilot',
    });
    this.cluster.grantAccess('ReadOnlyAccess', readOnlyRole.roleArn, [
      eks.AccessPolicy.fromAccessPolicyName('AmazonEKSViewPolicy', {
        accessScopeType: eks.AccessScopeType.CLUSTER,
      }),
    ]);

    void Duration.seconds(0); // keep import used across CDK versions

    // ---- Application workloads + public edge (same stack: see Workloads doc) ----
    this.workloads = new Workloads(this, 'Workloads', {
      config,
      vpc,
      cluster: this.cluster,
      fastApiRepository: props.fastApiRepository,
      cognito: props.cognito,
      namespaceDependency: this.appNamespaceManifest,
    });
    this.apiBaseUrl = this.workloads.apiBaseUrl;

    // ---- Outputs ----
    new CfnOutput(this, 'EksClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'EksClusterArn', { value: this.cluster.clusterArn });
    new CfnOutput(this, 'GpuNodeGroupName', { value: this.gpuNodeGroup.nodegroupName });
    new CfnOutput(this, 'CpuNodeGroupName', { value: this.cpuNodeGroup.nodegroupName });
    new CfnOutput(this, 'ClusterAdminRoleArn', { value: clusterAdminRole.roleArn });
    new CfnOutput(this, 'KubeconfigCommand', {
      value: `aws eks update-kubeconfig --name ${this.cluster.clusterName} --region ${config.region} --role-arn ${clusterAdminRole.roleArn}`,
    });
  }
}
