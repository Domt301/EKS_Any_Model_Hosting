import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, resourceName } from '../config/environment-config';

export interface NetworkStackProps extends StackProps {
  readonly config: PilotEnvironmentConfig;
}

/**
 * VPC with public + private-with-egress subnets across 2 AZs, tagged for EKS
 * load-balancer discovery. A single NAT gateway is the pilot default to control
 * cost (documented as not-HA in the README).
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: resourceName(config, 'vpc'),
      maxAzs: 2,
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      natGateways: config.natGatewayCount,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
      ],
    });

    // Subnet tags required by the AWS Load Balancer Controller for auto-discovery.
    for (const subnet of this.vpc.publicSubnets) {
      Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    }
    for (const subnet of this.vpc.privateSubnets) {
      Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    }

    // Interface/gateway endpoints reduce NAT egress cost and keep control-plane
    // traffic on the AWS backbone. Kept to the high-value set (spec: do not add
    // every possible endpoint automatically).
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      CloudWatchLogs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      Sts: ec2.InterfaceVpcEndpointAwsService.STS,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    };
    for (const [name, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(name, {
        service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, exportName: `${this.stackName}-VpcId` });
    new CfnOutput(this, 'PublicSubnetIds', {
      value: this.vpc.publicSubnets.map((s) => s.subnetId).join(','),
    });
    new CfnOutput(this, 'PrivateSubnetIds', {
      value: this.vpc.privateSubnets.map((s) => s.subnetId).join(','),
    });
  }
}
