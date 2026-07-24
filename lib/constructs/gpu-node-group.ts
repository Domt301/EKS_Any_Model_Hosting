import { Size } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, resourceName } from '../config/environment-config';

export interface GpuNodeGroupProps {
  readonly config: PilotEnvironmentConfig;
  readonly cluster: eks.Cluster;
}

/**
 * Single dedicated GPU managed node group for the vLLM inference workload.
 *
 * - min=desired=max=1 (pilot: no GPU autoscaling, no HA GPU redundancy).
 * - Tainted `dedicated=inference:NoSchedule` so only the vLLM pod (with the
 *   matching toleration) is placed here.
 * - Uses the EKS GPU-accelerated AMI (NVIDIA drivers pre-installed); the
 *   NVIDIA device plugin is deployed separately to expose `nvidia.com/gpu`.
 */
export class GpuNodeGroup extends Construct {
  public readonly nodeGroup: eks.Nodegroup;

  constructor(scope: Construct, id: string, props: GpuNodeGroupProps) {
    super(scope, id);
    const { config, cluster } = props;

    this.nodeGroup = cluster.addNodegroupCapacity('GpuNodeGroup', {
      nodegroupName: resourceName(config, 'gpu'),
      instanceTypes: config.gpuNodeInstanceTypes.map((t) => new ec2.InstanceType(t)),
      minSize: 1,
      desiredSize: 1,
      maxSize: 1,
      capacityType: eks.CapacityType.ON_DEMAND,
      amiType: eks.NodegroupAmiType.AL2_X86_64_GPU,
      diskSize: config.gpuNodeDiskSizeGiB,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      labels: {
        'workload-type': 'inference',
        accelerator: 'nvidia',
        'model-family': 'llama',
        // The NVIDIA device-plugin chart's default nodeAffinity requires a
        // GPU-present feature label (normally set by Node Feature Discovery,
        // which we don't run). Set the plugin's `nvidia.com/gpu.present=true`
        // label directly on the node group so the daemonset schedules and
        // advertises `nvidia.com/gpu` — otherwise vLLM stays Pending. The
        // `nvidia.com/` prefix is allowed on managed node groups (unlike the
        // reserved `feature.node.kubernetes.io/` / `kubernetes.io/` prefixes).
        'nvidia.com/gpu.present': 'true',
      },
      taints: [
        {
          effect: eks.TaintEffect.NO_SCHEDULE,
          key: 'dedicated',
          value: 'inference',
        },
      ],
      tags: {
        'llama-pilot:node-role': 'gpu-inference',
      },
    });

    // AMI type: use the **AL2023 NVIDIA** EKS-optimized GPU AMI. Amazon Linux 2
    // GPU AMIs (`AL2_x86_64_GPU`) are end-of-support and CloudFormation early
    // validation rejects them on current Kubernetes versions. CDK 2.170's
    // `NodegroupAmiType` enum predates the AL2023 GPU type and its L2 validation
    // only allows `AL2_x86_64_GPU` for GPU instances, so we set the pinned
    // enum above (to satisfy that check) and override the L1 property here.
    const cfnNodegroup = this.nodeGroup.node.defaultChild as eks.CfnNodegroup;
    cfnNodegroup.amiType = 'AL2023_x86_64_NVIDIA';

    // Larger root volume for model cache is expressed via diskSize above; keep a
    // typed reference for readability / future launch-template migration.
    void Size.gibibytes(config.gpuNodeDiskSizeGiB);
  }
}
