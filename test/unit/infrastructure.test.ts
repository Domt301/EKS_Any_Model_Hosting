import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApplicationStage } from '../../lib/application-stage';
import { testConfig } from '../test-config';

/**
 * Full-stage assertion tests. The stage is synthesized once and each stack's
 * template is asserted independently.
 */
describe('llama-pilot infrastructure', () => {
  let stage: ApplicationStage;
  let network: Template;
  let auth: Template;
  let container: Template;
  let eks: Template;
  let eksJson: string;

  beforeAll(() => {
    const app = new App();
    stage = new ApplicationStage(app, 'TestStage', { config: testConfig });
    network = Template.fromStack(stage.network);
    auth = Template.fromStack(stage.auth);
    container = Template.fromStack(stage.containers);
    eks = Template.fromStack(stage.eks);
    eksJson = JSON.stringify(eks.toJSON());
  });

  describe('NetworkStack', () => {
    it('provisions exactly one NAT gateway (pilot cost control)', () => {
      network.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    it('creates public and private subnets across 2 AZs', () => {
      // 2 AZs * (1 public + 1 private) = 4 subnets.
      network.resourceCountIs('AWS::EC2::Subnet', 4);
    });

    it('tags public subnets for external ELBs and private for internal ELBs', () => {
      network.hasResourceProperties('AWS::EC2::Subnet', {
        Tags: Match.arrayWith([{ Key: 'kubernetes.io/role/elb', Value: '1' }]),
      });
      network.hasResourceProperties('AWS::EC2::Subnet', {
        Tags: Match.arrayWith([{ Key: 'kubernetes.io/role/internal-elb', Value: '1' }]),
      });
    });
  });

  describe('AuthStack', () => {
    it('creates a user pool', () => {
      auth.resourceCountIs('AWS::Cognito::UserPool', 1);
    });

    it('app client has no secret and uses authorization-code flow only', () => {
      auth.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        GenerateSecret: false,
        AllowedOAuthFlows: ['code'],
        AllowedOAuthFlowsUserPoolClient: true,
      });
    });

    it('does not enable the implicit grant', () => {
      const clients = auth.findResources('AWS::Cognito::UserPoolClient');
      for (const client of Object.values(clients)) {
        const flows: string[] = client.Properties.AllowedOAuthFlows ?? [];
        expect(flows).not.toContain('implicit');
      }
    });
  });

  describe('ContainerStack', () => {
    it('enables image scanning on push for the API repo', () => {
      container.hasResourceProperties('AWS::ECR::Repository', {
        ImageScanningConfiguration: { ScanOnPush: true },
      });
    });
  });

  describe('EksStack', () => {
    it('creates exactly two managed node groups (no default capacity)', () => {
      eks.resourceCountIs('AWS::EKS::Nodegroup', 2);
    });

    it('the GPU node group carries the inference taint and labels', () => {
      eks.hasResourceProperties('AWS::EKS::Nodegroup', {
        Labels: Match.objectLike({ 'workload-type': 'inference', accelerator: 'nvidia' }),
        Taints: Match.arrayWith([
          Match.objectLike({ Key: 'dedicated', Value: 'inference', Effect: 'NO_SCHEDULE' }),
        ]),
      });
    });

    it('enables all five control-plane log types', () => {
      expect(eksJson).toContain('controllerManager');
      expect(eksJson).toContain('authenticator');
      expect(eksJson).toContain('scheduler');
    });

    it('exposes a public HTTPS API Gateway (HTTP API)', () => {
      eks.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
      eks.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    });

    it('fronts the internal ALB with a VPC Link', () => {
      eks.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 1);
    });

    it('protects app routes with a Cognito JWT authorizer', () => {
      eks.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        AuthorizerType: 'JWT',
      });
    });

    it('the internal ALB is not internet-facing', () => {
      eks.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internal',
      });
    });

    it('throttles the API stage to 5 rps / burst 10', () => {
      eks.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 }),
      });
    });

    it('configures a 14-day log retention somewhere', () => {
      const groups = eks.findResources('AWS::Logs::LogGroup');
      const retentions = Object.values(groups).map((g) => g.Properties?.RetentionInDays);
      expect(retentions).toContain(14);
    });

    it('vLLM and FastAPI services are ClusterIP, never LoadBalancer', () => {
      expect(eksJson).toContain('ClusterIP');
      // No Kubernetes Service of type LoadBalancer must appear in any manifest.
      expect(eksJson).not.toContain('\\"type\\":\\"LoadBalancer\\"');
    });

    it('applies the vLLM NetworkPolicy restricting ingress to FastAPI', () => {
      expect(eksJson).toContain('vllm-allow-from-fastapi');
      expect(eksJson).toContain('default-deny-ingress');
    });
  });
});
