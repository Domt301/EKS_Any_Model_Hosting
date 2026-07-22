import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig } from '../config/environment-config';
import { APP_NAMESPACE } from '../constants';

export interface VllmWorkloadProps {
  readonly config: PilotEnvironmentConfig;
  readonly cluster: eks.Cluster;
  /** Manifest(s) that must exist first (e.g. the namespace). */
  readonly dependsOn?: Construct[];
}

/**
 * Private vLLM inference server.
 *
 * - ClusterIP service only (never public: no ingress, no LB, no public IP).
 * - Runs exclusively on the tainted GPU node group (nodeSelector + toleration).
 * - 1 replica, Recreate strategy (a single GPU cannot host two model copies).
 * - Hugging Face token is injected from a Kubernetes Secret that the deploy
 *   script creates from Secrets Manager — never committed, never in the image.
 */
export class VllmWorkload extends Construct {
  public readonly serviceName = 'vllm';
  public readonly internalUrl = `http://vllm.${APP_NAMESPACE}.svc.cluster.local:8000`;

  constructor(scope: Construct, id: string, props: VllmWorkloadProps) {
    super(scope, id);
    const { config, cluster } = props;

    const labels = { app: 'vllm', 'app.kubernetes.io/part-of': 'llama-pilot' };

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'vllm', namespace: APP_NAMESPACE, labels },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: 'vllm' } },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: 'vllm',
            nodeSelector: { 'workload-type': 'inference' },
            tolerations: [
              { key: 'dedicated', operator: 'Equal', value: 'inference', effect: 'NoSchedule' },
              { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' },
            ],
            securityContext: {
              runAsNonRoot: false, // vLLM/CUDA runtime typically needs root inside the container
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'vllm',
                image: config.vllmImage,
                imagePullPolicy: 'IfNotPresent',
                command: ['vllm', 'serve', config.modelId],
                args: [
                  '--served-model-name',
                  config.servedModelName,
                  '--revision',
                  config.modelRevision,
                  '--host',
                  '0.0.0.0',
                  '--port',
                  '8000',
                  '--dtype',
                  'auto',
                  '--max-model-len',
                  String(config.maxModelLength),
                  '--gpu-memory-utilization',
                  String(config.gpuMemoryUtilization),
                  '--max-num-seqs',
                  '4',
                  '--enable-prefix-caching',
                ],
                ports: [{ name: 'http', containerPort: 8000 }],
                env: [
                  { name: 'HOME', value: '/home/vllm' },
                  { name: 'HF_HOME', value: '/models' },
                  {
                    name: 'HUGGING_FACE_HUB_TOKEN',
                    valueFrom: {
                      secretKeyRef: { name: 'huggingface-token', key: 'token', optional: true },
                    },
                  },
                ],
                resources: {
                  limits: { 'nvidia.com/gpu': '1' },
                  requests: { cpu: '2', memory: '8Gi' },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: false,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  { name: 'model-cache', mountPath: '/models' },
                  { name: 'dshm', mountPath: '/dev/shm' },
                  { name: 'home', mountPath: '/home/vllm' },
                ],
                // Long startup allowance for model download + weight load.
                startupProbe: {
                  httpGet: { path: '/health', port: 8000 },
                  periodSeconds: 15,
                  failureThreshold: 80, // ~20 min
                  timeoutSeconds: 5,
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: 8000 },
                  periodSeconds: 10,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
                livenessProbe: {
                  httpGet: { path: '/health', port: 8000 },
                  periodSeconds: 30,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
            volumes: [
              { name: 'model-cache', emptyDir: { sizeLimit: '100Gi' } },
              { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '4Gi' } },
              { name: 'home', emptyDir: {} },
            ],
          },
        },
      },
    };

    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'vllm', namespace: APP_NAMESPACE, labels },
      spec: {
        type: 'ClusterIP',
        selector: { app: 'vllm' },
        ports: [{ name: 'http', port: 8000, targetPort: 8000, protocol: 'TCP' }],
      },
    };

    const serviceAccount = {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'vllm', namespace: APP_NAMESPACE },
    };

    const manifest = cluster.addManifest('VllmManifest', serviceAccount, service, deployment);
    for (const dep of props.dependsOn ?? []) {
      manifest.node.addDependency(dep);
    }
  }
}
