import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, resourceName } from '../config/environment-config';

export interface ObservabilityProps {
  readonly config: PilotEnvironmentConfig;
  readonly clusterName: string;
  readonly httpApiId: string;
  readonly apiStageName: string;
  readonly gpuNodeGroupName: string;
}

/**
 * CloudWatch log groups, an operational dashboard, alarms, and an SNS topic for
 * notifications. Application (FastAPI/vLLM) logs and GPU metrics are collected
 * by the CloudWatch Observability add-on into Container Insights; this construct
 * owns the API Gateway access-log group, the dashboard, and the alarm set.
 */
export class Observability extends Construct {
  public readonly apiGatewayAccessLogs: logs.LogGroup;
  public readonly alarmTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    const { config } = props;
    const retention = mapRetention(config.logRetentionDays);

    this.apiGatewayAccessLogs = new logs.LogGroup(this, 'ApiGatewayAccessLogs', {
      logGroupName: `/llama-pilot/${config.environmentName}/api-gateway/access`,
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Application log group used by the CloudWatch agent (Container Insights
    // application logs). Declared here so retention is managed by CDK.
    new logs.LogGroup(this, 'ApplicationLogs', {
      logGroupName: `/aws/containerinsights/${props.clusterName}/application`,
      retention,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: resourceName(config, 'alarms'),
      displayName: 'llama-pilot alarms',
    });
    const action = new cwActions.SnsAction(this.alarmTopic);

    // ---- API Gateway metrics ----
    const apiDims = { ApiId: props.httpApiId, Stage: props.apiStageName };
    const metric = (name: string, stat: string, extra: Partial<cloudwatch.MetricProps> = {}) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: name,
        dimensionsMap: apiDims,
        statistic: stat,
        period: Duration.minutes(1),
        ...extra,
      });

    const count = metric('Count', 'Sum');
    const err5xx = metric('5xx', 'Sum');
    const err4xx = metric('4xx', 'Sum');
    const latency = metric('Latency', 'p95');
    const integrationLatency = metric('IntegrationLatency', 'p95');

    // Guard against divide-by-zero with IF (CloudWatch metric math does not
    // support MAX of a [TimeSeries, Scalar] array). When there are no requests
    // the rate is 0; treatMissingData handles gaps.
    const err5xxRate = new cloudwatch.MathExpression({
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: { errors: err5xx, requests: count },
      label: 'API 5xx error rate (%)',
      period: Duration.minutes(5),
    });

    // ---- Container Insights (pods / nodes / GPU) ----
    const ciNamespace = 'ContainerInsights';
    const podRestarts = new cloudwatch.Metric({
      namespace: ciNamespace,
      metricName: 'pod_number_of_container_restarts',
      dimensionsMap: { ClusterName: props.clusterName, Namespace: 'llama-pilot' },
      statistic: 'Sum',
      period: Duration.minutes(5),
    });
    const gpuUtil = new cloudwatch.Metric({
      namespace: ciNamespace,
      metricName: 'container_gpu_utilization',
      dimensionsMap: { ClusterName: props.clusterName },
      statistic: 'Average',
      period: Duration.minutes(1),
    });
    const gpuMemUtil = new cloudwatch.Metric({
      namespace: ciNamespace,
      metricName: 'container_gpu_memory_utilization',
      dimensionsMap: { ClusterName: props.clusterName },
      statistic: 'Average',
      period: Duration.minutes(1),
    });
    const nodeCount = new cloudwatch.Metric({
      namespace: ciNamespace,
      metricName: 'cluster_failed_node_count',
      dimensionsMap: { ClusterName: props.clusterName },
      statistic: 'Maximum',
      period: Duration.minutes(1),
    });

    // ---- Alarms ----
    const alarms: cloudwatch.Alarm[] = [
      new cloudwatch.Alarm(this, 'Api5xxAlarm', {
        alarmName: resourceName(config, 'api-5xx'),
        metric: err5xxRate,
        threshold: 5,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'API Gateway 5xx error rate above 5% for 15 minutes',
      }),
      new cloudwatch.Alarm(this, 'ApiIntegrationLatencyAlarm', {
        alarmName: resourceName(config, 'api-integration-latency'),
        metric: integrationLatency,
        threshold: 28000, // ms; HTTP API integration timeout ceiling is 30s
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Backend integration latency approaching the API Gateway timeout',
      }),
      new cloudwatch.Alarm(this, 'PodRestartAlarm', {
        alarmName: resourceName(config, 'pod-restarts'),
        metric: podRestarts,
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Repeated container restarts in the llama-pilot namespace',
      }),
      new cloudwatch.Alarm(this, 'GpuMemoryAlarm', {
        alarmName: resourceName(config, 'gpu-memory-high'),
        metric: gpuMemUtil,
        threshold: 95,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'GPU memory utilization sustained above 95%',
      }),
      new cloudwatch.Alarm(this, 'FailedNodeAlarm', {
        alarmName: resourceName(config, 'failed-nodes'),
        metric: nodeCount,
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'One or more EKS nodes reported as failed',
      }),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    }

    // ---- Dashboard ----
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: resourceName(config, 'dashboard'),
    });
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# llama-pilot (${config.environmentName})\nAPI, model, GPU, pod and node health for the self-hosted Llama pilot.`,
        width: 24,
        height: 2,
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API requests & errors',
        left: [count],
        right: [err4xx, err5xx],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API latency (p95)',
        left: [latency, integrationLatency],
        width: 12,
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'GPU utilization / memory',
        left: [gpuUtil, gpuMemUtil],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Pod restarts & failed nodes',
        left: [podRestarts],
        right: [nodeCount],
        width: 12,
      }),
    );
  }
}

function mapRetention(days: number): logs.RetentionDays {
  const known: Record<number, logs.RetentionDays> = {
    1: logs.RetentionDays.ONE_DAY,
    3: logs.RetentionDays.THREE_DAYS,
    5: logs.RetentionDays.FIVE_DAYS,
    7: logs.RetentionDays.ONE_WEEK,
    14: logs.RetentionDays.TWO_WEEKS,
    30: logs.RetentionDays.ONE_MONTH,
    60: logs.RetentionDays.TWO_MONTHS,
    90: logs.RetentionDays.THREE_MONTHS,
  };
  return known[days] ?? logs.RetentionDays.TWO_WEEKS;
}
