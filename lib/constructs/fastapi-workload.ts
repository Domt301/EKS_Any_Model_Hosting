import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig } from '../config/environment-config';
import { APP_NAMESPACE } from '../constants';

export interface FastapiCognitoConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly appClientId: string;
  readonly issuer: string;
  readonly jwksUrl: string;
}

export interface FastapiWorkloadProps {
  readonly config: PilotEnvironmentConfig;
  readonly cluster: eks.Cluster;
  /** Fully-qualified container image reference (repo URI + tag/digest). */
  readonly imageUri: string;
  readonly cognito: FastapiCognitoConfig;
  readonly vllmBaseUrl: string;
  /** Origin allowed by the FastAPI CORS layer (defence-in-depth with API GW). */
  readonly corsAllowOrigin: string;
  readonly dependsOn?: Construct[];
}

/**
 * FastAPI application-boundary workload (the public API surface).
 *
 * - 2 replicas on the general (CPU) node group, preferred pod anti-affinity.
 * - Restricted securityContext (non-root, read-only root fs, all caps dropped).
 * - ClusterIP service on :80 -> container :8080; exposed publicly only via the
 *   internal ALB + API Gateway path, never directly.
 * - System prompt is sourced from a ConfigMap (not baked into the image).
 * - Service account has NO AWS permissions by default.
 */
export class FastapiWorkload extends Construct {
  public readonly serviceName = 'fastapi';
  public readonly servicePort = 80;
  public readonly containerPort = 8080;

  constructor(scope: Construct, id: string, props: FastapiWorkloadProps) {
    super(scope, id);
    const { config, cluster, cognito } = props;

    const labels = { app: 'fastapi', 'app.kubernetes.io/part-of': 'llama-pilot' };

    const configMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'fastapi-config', namespace: APP_NAMESPACE },
      data: {
        SYSTEM_PROMPT:
          'You are a helpful, concise assistant hosted for an internal pilot. ' +
          'Answer clearly and refuse unsafe requests.',
        COGNITO_REGION: cognito.region,
        COGNITO_USER_POOL_ID: cognito.userPoolId,
        COGNITO_APP_CLIENT_ID: cognito.appClientId,
        COGNITO_ISSUER: cognito.issuer,
        COGNITO_JWKS_URL: cognito.jwksUrl,
        VLLM_BASE_URL: props.vllmBaseUrl,
        SERVED_MODEL_NAME: config.servedModelName,
        MAX_MODEL_LENGTH: String(config.maxModelLength),
        MAX_OUTPUT_TOKENS: String(config.maxOutputTokens),
        MAX_CONCURRENT_INFERENCE: '4',
        REQUEST_TIMEOUT_SECONDS: '120',
        GENERATION_TIMEOUT_SECONDS: '300',
        // In-memory conversation context (see app.sessions).
        SESSION_MAX_TURNS: '12',
        SESSION_TTL_SECONDS: '1800',
        SESSION_MAX_SESSIONS: '1000',
        LOG_LEVEL: 'INFO',
        LOG_PROMPTS: 'false',
        CORS_ALLOW_ORIGINS: props.corsAllowOrigin,
      },
    };

    const serviceAccount = {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: 'fastapi',
        namespace: APP_NAMESPACE,
        // No IRSA/Pod-Identity annotation: FastAPI needs no AWS permissions.
      },
    };

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'fastapi', namespace: APP_NAMESPACE, labels },
      spec: {
        replicas: 2,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
        },
        selector: { matchLabels: { app: 'fastapi' } },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: 'fastapi',
            // Disable Docker-links-style service env injection (best practice;
            // pods discover each other via DNS). Avoids surprise collisions like
            // the vLLM `VLLM_PORT` one.
            enableServiceLinks: false,
            nodeSelector: { 'workload-type': 'general' },
            terminationGracePeriodSeconds: 30,
            affinity: {
              podAntiAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                  {
                    weight: 100,
                    podAffinityTerm: {
                      labelSelector: { matchLabels: { app: 'fastapi' } },
                      topologyKey: 'kubernetes.io/hostname',
                    },
                  },
                ],
              },
            },
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              fsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'fastapi',
                image: props.imageUri,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ name: 'http', containerPort: this.containerPort }],
                envFrom: [{ configMapRef: { name: 'fastapi-config' } }],
                resources: {
                  requests: { cpu: '250m', memory: '512Mi' },
                  limits: { cpu: '1', memory: '1Gi' },
                },
                securityContext: {
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
                startupProbe: {
                  httpGet: { path: '/health/live', port: this.containerPort },
                  periodSeconds: 3,
                  failureThreshold: 20,
                },
                livenessProbe: {
                  httpGet: { path: '/health/live', port: this.containerPort },
                  periodSeconds: 15,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
                readinessProbe: {
                  httpGet: { path: '/health/ready', port: this.containerPort },
                  periodSeconds: 10,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
              },
            ],
            volumes: [{ name: 'tmp', emptyDir: {} }],
          },
        },
      },
    };

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'fastapi',
        namespace: APP_NAMESPACE,
        labels,
      },
      spec: {
        type: 'ClusterIP',
        selector: { app: 'fastapi' },
        ports: [
          { name: 'http', port: this.servicePort, targetPort: this.containerPort, protocol: 'TCP' },
        ],
      },
    };

    const manifest = cluster.addManifest(
      'FastapiManifest',
      configMap,
      serviceAccount,
      service,
      deployment,
    );
    for (const dep of props.dependsOn ?? []) {
      manifest.node.addDependency(dep);
    }
  }
}
