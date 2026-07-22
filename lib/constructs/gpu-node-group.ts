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

    // Larger root volume for model cache is expressed via diskSize above; keep a
    // typed reference for readability / future launch-template migration.
    void Size.gibibytes(config.gpuNodeDiskSizeGiB);
  }
}
