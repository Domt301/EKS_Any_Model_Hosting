#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { loadPilotConfig } from '../lib/config/environment-config';
import { ApplicationStage } from '../lib/application-stage';

const app = new cdk.App();
const config = loadPilotConfig(app);

// A single stage groups all stacks so `cdk deploy --all` provisions the whole
// pilot in dependency order. Stack names are prefixed `LlamaPilot-<Env>-*`.
new ApplicationStage(app, `LlamaPilot-${config.environmentName}`, { config });

app.synth();
