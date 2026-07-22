import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpAlbIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, resourceName } from '../config/environment-config';
import { APP_NAMESPACE } from '../constants';
import { VllmWorkload } from '../constructs/vllm-workload';
import { FastapiWorkload, FastapiCognitoConfig } from '../constructs/fastapi-workload';
import { Observability } from '../constructs/observability';

export interface WorkloadsProps {
  readonly config: PilotEnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly cluster: eks.Cluster;
  readonly fastApiRepository: ecr.IRepository;
  readonly cognito: FastapiCognitoConfig;
  /** Namespace manifest that workloads must be sequenced after. */
  readonly namespaceDependency: Construct;
}

/**
 * Application workloads (vLLM + FastAPI), the private network path
 * (internal ALB + TargetGroupBinding), the public HTTPS edge (API Gateway HTTP
 * API + VPC Link + Cognito JWT authorizer), Kubernetes NetworkPolicies, and
 * observability.
 *
 * This is a Construct (not a Stack): CDK always places `cluster.addManifest`
 * resources in the *cluster's* stack, so the workloads must share that stack to
 * avoid a cyclic cross-stack dependency between the cluster security group and
 * the FastAPI target group. It is therefore instantiated inside {@link EksStack}.
 */
export class Workloads extends Construct {
  public readonly apiBaseUrl: string;

  constructor(scope: Construct, id: string, props: WorkloadsProps) {
    super(scope, id);
    const { config, vpc, cluster } = props;

    // CORS/allowed origin: derived from the first Cognito callback URL. The
    // two-phase deploy (see README §Amplify callback workflow) updates this to
    // the real Amplify domain and redeploys.
    const spaOrigin = originOf(config.cognitoCallbackUrls[0]);

    const imageTag = (this.node.tryGetContext('apiImageTag') as string) ?? 'latest';
    const imageUri = `${props.fastApiRepository.repositoryUri}:${imageTag}`;

    // ---------------------------------------------------------------------
    // Workloads
    // ---------------------------------------------------------------------
    const vllm = new VllmWorkload(this, 'Vllm', {
      config,
      cluster,
      dependsOn: [props.namespaceDependency],
    });

    const fastapi = new FastapiWorkload(this, 'Fastapi', {
      config,
      cluster,
      imageUri,
      cognito: props.cognito,
      vllmBaseUrl: vllm.internalUrl,
      corsAllowOrigin: spaOrigin,
      dependsOn: [props.namespaceDependency],
    });

    this.applyNetworkPolicies(cluster, props.namespaceDependency);

    // ---------------------------------------------------------------------
    // Private network path: internal ALB + TargetGroupBinding
    // ---------------------------------------------------------------------
    const albSg = new ec2.SecurityGroup(this, 'InternalAlbSg', {
      vpc,
      description: 'Internal ALB for FastAPI (fronted by API Gateway VPC Link)',
      allowAllOutbound: true,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
      loadBalancerName: resourceName(config, 'api-alb'),
      vpc,
      internetFacing: false,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'FastapiTargetGroup', {
      targetGroupName: resourceName(config, 'api-tg'),
      vpc,
      port: fastapi.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health/ready',
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(10),
    });

    alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // Allow the internal ALB to reach the FastAPI pods (VPC CNI pod ENIs use the
    // cluster security group). Created here to avoid a cross-stack SG cycle.
    new ec2.CfnSecurityGroupIngress(this, 'AlbToPodsIngress', {
      groupId: cluster.clusterSecurityGroupId,
      sourceSecurityGroupId: albSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: fastapi.containerPort,
      toPort: fastapi.containerPort,
      description: 'Internal ALB -> FastAPI pods',
    });

    // Bind the FastAPI Service to the CDK-created target group via the LBC CRD.
    const tgb = cluster.addManifest('FastapiTargetGroupBinding', {
      apiVersion: 'elbv2.k8s.aws/v1beta1',
      kind: 'TargetGroupBinding',
      metadata: { name: 'fastapi', namespace: APP_NAMESPACE },
      spec: {
        serviceRef: { name: fastapi.serviceName, port: fastapi.servicePort },
        targetGroupARN: targetGroup.targetGroupArn,
        targetType: 'ip',
      },
    });
    tgb.node.addDependency(props.namespaceDependency);

    // ---------------------------------------------------------------------
    // Public HTTPS edge: API Gateway HTTP API + VPC Link + JWT authorizer
    // ---------------------------------------------------------------------
    const vpcLinkSg = new ec2.SecurityGroup(this, 'VpcLinkSg', {
      vpc,
      description: 'API Gateway VPC Link -> internal ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(vpcLinkSg, ec2.Port.tcp(80), 'VPC Link -> internal ALB');

    const vpcLink = new apigwv2.VpcLink(this, 'VpcLink', {
      vpcLinkName: resourceName(config, 'vpc-link'),
      vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcLinkSg],
    });

    const listener = alb.listeners[0];
    const integration = new HttpAlbIntegration('AlbIntegration', listener, {
      vpcLink,
      // HTTP APIs cap integration timeout at 29s; SSE generations must complete
      // within this window (documented limitation — see README/ADR-005).
      timeout: Duration.seconds(29),
    });

    const authorizer = new HttpJwtAuthorizer('CognitoJwt', props.cognito.issuer, {
      authorizerName: resourceName(config, 'cognito-jwt'),
      jwtAudience: [props.cognito.appClientId],
      identitySource: ['$request.header.Authorization'],
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: resourceName(config, 'api'),
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [spaOrigin],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Request-ID'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: Duration.hours(1),
      },
    });

    // Authenticated application routes.
    for (const [method, path] of [
      [apigwv2.HttpMethod.POST, '/api/v1/chat/completions'],
      [apigwv2.HttpMethod.GET, '/api/v1/models'],
      [apigwv2.HttpMethod.GET, '/api/v1/me'],
    ] as const) {
      httpApi.addRoutes({ path, methods: [method], integration, authorizer });
    }
    // Public health routes (no auth) for smoke tests / load-balancer probes.
    httpApi.addRoutes({
      path: '/health/live',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });
    httpApi.addRoutes({
      path: '/health/ready',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    const observability = new Observability(this, 'Observability', {
      config,
      clusterName: cluster.clusterName,
      httpApiId: httpApi.apiId,
      apiStageName: '$default',
      gpuNodeGroupName: resourceName(config, 'gpu'),
    });

    const stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 5, burstLimit: 10 },
    });
    // Access logging via escape hatch (not yet exposed on the L2 HttpStage).
    const cfnStage = stage.node.defaultChild as CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: observability.apiGatewayAccessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        integrationLatency: '$context.integrationLatency',
        authError: '$context.authorizer.error',
      }),
    };

    this.apiBaseUrl = stage.url.replace(/\/$/, '');

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new CfnOutput(this, 'ApiBaseUrl', { value: this.apiBaseUrl });
    new CfnOutput(this, 'InternalAlbDnsName', { value: alb.loadBalancerDnsName });
    new CfnOutput(this, 'HttpApiId', { value: httpApi.apiId });
    new CfnOutput(this, 'ServedModelName', { value: config.servedModelName });
    new CfnOutput(this, 'VllmInternalUrl', { value: vllm.internalUrl });
    new CfnOutput(this, 'AlarmTopicArn', { value: observability.alarmTopic.topicArn });
    new CfnOutput(this, 'DashboardName', { value: observability.dashboard.dashboardName });

    void RemovalPolicy.DESTROY;
  }

  /**
   * NetworkPolicies enforcing the intended traffic matrix:
   * - default-deny ingress in the app namespace,
   * - vLLM accepts ingress only from FastAPI on 8000,
   * - FastAPI accepts ingress on 8080 (from the ALB path) and may egress to
   *   vLLM, DNS, and HTTPS (Cognito JWKS),
   * - DNS remains functional for all pods.
   */
  private applyNetworkPolicies(cluster: eks.Cluster, namespaceDependency: Construct): void {
    const dnsEgress = {
      to: [{ namespaceSelector: {} }],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    };

    const policies = [
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'default-deny-ingress', namespace: APP_NAMESPACE },
        spec: { podSelector: {}, policyTypes: ['Ingress'] },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'vllm-allow-from-fastapi', namespace: APP_NAMESPACE },
        spec: {
          podSelector: { matchLabels: { app: 'vllm' } },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [{ podSelector: { matchLabels: { app: 'fastapi' } } }],
              ports: [{ protocol: 'TCP', port: 8000 }],
            },
          ],
        },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'fastapi-ingress', namespace: APP_NAMESPACE },
        spec: {
          podSelector: { matchLabels: { app: 'fastapi' } },
          policyTypes: ['Ingress'],
          // Ingress from the ALB (node/VPC source IPs) — allow the container port.
          ingress: [{ ports: [{ protocol: 'TCP', port: 8080 }] }],
        },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'fastapi-egress', namespace: APP_NAMESPACE },
        spec: {
          podSelector: { matchLabels: { app: 'fastapi' } },
          policyTypes: ['Egress'],
          egress: [
            dnsEgress,
            {
              to: [{ podSelector: { matchLabels: { app: 'vllm' } } }],
              ports: [{ protocol: 'TCP', port: 8000 }],
            },
            // HTTPS egress for Cognito JWKS retrieval.
            { ports: [{ protocol: 'TCP', port: 443 }] },
          ],
        },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'vllm-egress', namespace: APP_NAMESPACE },
        spec: {
          podSelector: { matchLabels: { app: 'vllm' } },
          policyTypes: ['Egress'],
          // DNS + HTTPS (model/weights download from Hugging Face over NAT).
          egress: [dnsEgress, { ports: [{ protocol: 'TCP', port: 443 }] }],
        },
      },
    ];

    const manifest = cluster.addManifest('NetworkPolicies', ...policies);
    manifest.node.addDependency(namespaceDependency);
  }
}

/** Extract the scheme+host origin from a URL string. */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url.replace(/\/$/, '');
  }
}
