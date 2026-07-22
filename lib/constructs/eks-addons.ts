import { CfnJson } from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface EksAddonsProps {
  readonly cluster: eks.Cluster;
  /**
   * Pinned add-on versions keyed by add-on name. When a version is omitted, EKS
   * resolves the default version compatible with the cluster's Kubernetes
   * version. Pin these once validated with:
   *   aws eks describe-addon-versions --addon-name <name> --kubernetes-version <ver>
   */
  readonly addonVersions?: Record<string, string>;
}

/**
 * Core EKS managed add-ons plus the NVIDIA device plugin.
 *
 * The AWS Load Balancer Controller is installed separately via the built-in
 * `albController` property on the cluster (EksStack) so its IRSA policy is
 * managed by CDK. CoreDNS / kube-proxy / VPC CNI are installed by EKS by
 * default; declaring them as managed add-ons here lets us control versions and
 * conflict resolution explicitly.
 */
export class EksAddons extends Construct {
  constructor(scope: Construct, id: string, props: EksAddonsProps) {
    super(scope, id);
    const { cluster } = props;
    const versions = props.addonVersions ?? {};

    const oidcArn = cluster.openIdConnectProvider.openIdConnectProviderArn;
    const oidcIssuer = cluster.openIdConnectProvider.openIdConnectProviderIssuer;

    const irsaRole = (
      id2: string,
      namespace: string,
      serviceAccount: string,
      managedPolicyArns: string[],
    ): iam.Role => {
      // The OIDC issuer is a deploy-time token, so the StringEquals condition
      // (which uses it as a map *key*) must be wrapped in CfnJson to defer
      // resolution — otherwise synth fails on the unresolved intrinsic key.
      const condition = new CfnJson(this, `${id2}TrustCondition`, {
        value: {
          [`${oidcIssuer}:aud`]: 'sts.amazonaws.com',
          [`${oidcIssuer}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
        },
      });
      const role = new iam.Role(this, id2, {
        assumedBy: new iam.FederatedPrincipal(
          oidcArn,
          { StringEquals: condition },
          'sts:AssumeRoleWithWebIdentity',
        ),
      });
      for (const arn of managedPolicyArns) {
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(arn));
      }
      return role;
    };

    const addon = (
      id2: string,
      addonName: string,
      opts: { serviceAccountRoleArn?: string; configurationValues?: string } = {},
    ): eks.CfnAddon => {
      const cfn = new eks.CfnAddon(this, id2, {
        addonName,
        clusterName: cluster.clusterName,
        addonVersion: versions[addonName],
        resolveConflicts: 'OVERWRITE',
        serviceAccountRoleArn: opts.serviceAccountRoleArn,
        configurationValues: opts.configurationValues,
      });
      cfn.node.addDependency(cluster);
      return cfn;
    };

    // Networking / DNS / proxy (default EKS add-ons, version-managed here).
    // NetworkPolicy enforcement is enabled so the VPC CNI actually applies the
    // Kubernetes NetworkPolicies that isolate vLLM.
    addon('VpcCni', 'vpc-cni', {
      configurationValues: JSON.stringify({ enableNetworkPolicy: 'true' }),
    });
    addon('CoreDns', 'coredns');
    addon('KubeProxy', 'kube-proxy');

    // Pod Identity agent — enables EKS Pod Identity associations for workloads.
    addon('PodIdentityAgent', 'eks-pod-identity-agent');

    // Metrics Server — required for `kubectl top` and HPA readiness signals.
    addon('MetricsServer', 'metrics-server');

    // EBS CSI driver (needs IAM to manage EBS volumes for the model cache PVs).
    const ebsCsiRole = irsaRole(
      'EbsCsiRole',
      'kube-system',
      'ebs-csi-controller-sa',
      ['service-role/AmazonEBSCSIDriverPolicy'],
    );
    addon('EbsCsiDriver', 'aws-ebs-csi-driver', {
      serviceAccountRoleArn: ebsCsiRole.roleArn,
    });

    // CloudWatch Observability (Container Insights + CloudWatch agent + Fluent Bit).
    const cwRole = irsaRole(
      'CloudWatchObservabilityRole',
      'amazon-cloudwatch',
      'cloudwatch-agent',
      ['CloudWatchAgentServerPolicy'],
    );
    addon('CloudWatchObservability', 'amazon-cloudwatch-observability', {
      serviceAccountRoleArn: cwRole.roleArn,
    });

    // NVIDIA device plugin — exposes `nvidia.com/gpu` as an allocatable resource.
    // Tolerates the GPU node taint and is pinned to a specific chart version.
    cluster.addHelmChart('NvidiaDevicePlugin', {
      chart: 'nvidia-device-plugin',
      repository: 'https://nvidia.github.io/k8s-device-plugin',
      release: 'nvidia-device-plugin',
      namespace: 'kube-system',
      version: '0.16.2',
      wait: false,
      values: {
        nodeSelector: { 'workload-type': 'inference' },
        tolerations: [
          { key: 'dedicated', operator: 'Equal', value: 'inference', effect: 'NoSchedule' },
          { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' },
        ],
      },
    });
  }
}
