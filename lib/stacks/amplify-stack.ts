import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, resourceName } from '../config/environment-config';
import { FastapiCognitoConfig } from '../constructs/fastapi-workload';

export interface AmplifyStackProps extends StackProps {
  readonly config: PilotEnvironmentConfig;
  readonly cognito: FastapiCognitoConfig;
  readonly cognitoDomain: string;
  readonly apiBaseUrl: string;
  /**
   * Initial redirect origin (placeholder). The two-phase deploy resolves the
   * real Amplify branch URL and updates both this app's redirect env vars and
   * the Cognito callback/logout allow-list (see README §Amplify callback
   * workflow). A CfnApp cannot reference its own generated default domain, so
   * this cannot be self-derived at create time.
   */
  readonly initialRedirectOrigin: string;
}

/**
 * Amplify Hosting application + main branch for the React SPA.
 *
 * The app is created without a connected git provider (no embedded provider
 * token). The SPA is deployed via a manual zip deployment from CI/CD
 * (`scripts/deploy-spa.sh`). A single-page rewrite rule routes all client-side
 * routes to `index.html`.
 */
export class AmplifyStack extends Stack {
  public readonly branchUrl: string;
  public readonly appId: string;

  constructor(scope: Construct, id: string, props: AmplifyStackProps) {
    super(scope, id, props);
    const { config } = props;
    const branchName = 'main';
    const redirect = props.initialRedirectOrigin.replace(/\/$/, '') + '/';

    const buildSpec = [
      'version: 1',
      'applications:',
      '  - appRoot: spa',
      '    frontend:',
      '      phases:',
      '        preBuild:',
      '          commands:',
      '            - npm ci',
      '        build:',
      '          commands:',
      '            - npm run build',
      '      artifacts:',
      '        baseDirectory: dist',
      '        files:',
      "          - '**/*'",
      '      cache:',
      '        paths:',
      '          - node_modules/**/*',
    ].join('\n');

    const app = new amplify.CfnApp(this, 'SpaApp', {
      name: resourceName(config, 'spa'),
      platform: 'WEB',
      buildSpec,
      // SPA rewrite: serve index.html for any non-asset path.
      customRules: [
        {
          source:
            '</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>',
          target: '/index.html',
          status: '200',
        },
      ],
      environmentVariables: [
        { name: 'VITE_AWS_REGION', value: props.cognito.region },
        { name: 'VITE_COGNITO_USER_POOL_ID', value: props.cognito.userPoolId },
        { name: 'VITE_COGNITO_APP_CLIENT_ID', value: props.cognito.appClientId },
        { name: 'VITE_COGNITO_DOMAIN', value: props.cognitoDomain },
        { name: 'VITE_COGNITO_REDIRECT_SIGN_IN', value: redirect },
        { name: 'VITE_COGNITO_REDIRECT_SIGN_OUT', value: redirect },
        { name: 'VITE_API_BASE_URL', value: props.apiBaseUrl },
        { name: 'VITE_MODEL_NAME', value: config.servedModelName },
      ],
    });

    const branch = new amplify.CfnBranch(this, 'MainBranch', {
      appId: app.attrAppId,
      branchName,
      enableAutoBuild: false,
      stage: 'PRODUCTION',
    });

    this.appId = app.attrAppId;
    this.branchUrl = `https://${branchName}.${app.attrDefaultDomain}`;

    new CfnOutput(this, 'AmplifyAppId', { value: app.attrAppId });
    new CfnOutput(this, 'AmplifyDefaultDomain', { value: app.attrDefaultDomain });
    new CfnOutput(this, 'AmplifyBranchName', { value: branch.branchName });
    new CfnOutput(this, 'AmplifyBranchUrl', { value: this.branchUrl });
  }
}
