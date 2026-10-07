import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CoreStack } from '../lib/core-stack.ts';

function synth(version = '1.2.3', logRetentionDays = 7) {
  const stack = new CoreStack(new App(), 'Core', { version, config: { logRetentionDays, gradualRelease: false } });
  return { stack, template: Template.fromStack(stack) };
}

describe('CoreStack', () => {
  const { stack, template } = synth();

  it('has a fixed stack name and no fixed account or region', () => {
    expect(stack.stackName).toBe('lab-svc-core');
    expect(stack.resolve(stack.account)).toEqual({ Ref: 'AWS::AccountId' });
    expect(stack.resolve(stack.region)).toEqual({ Ref: 'AWS::Region' });
  });

  it('has one Node.js 22 function that gets the version from the environment', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: { Variables: { VERSION: '1.2.3' } },
    });
  });

  it('keeps the logs for the number of days in the stage config', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    synth('1.2.3', 30).template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('has one route, GET /items, with IAM authorisation', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /items',
      AuthorizationType: 'AWS_IAM',
    });
  });

  it('writes the API URL to the SSM parameter /lab/core/url', () => {
    const apiId = Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))[0];
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/core/url',
      Type: 'String',
      // CloudFormation returns the endpoint as https://<api-id>.execute-api.<region>.amazonaws.com
      Value: { 'Fn::GetAtt': [apiId, 'ApiEndpoint'] },
    });
  });

  it('writes the execute-api ARN of GET /items to the SSM parameter /lab/core/api-arn', () => {
    const apiId = Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))[0];
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/core/api-arn',
      Type: 'String',
      Value: {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':execute-api:',
            { Ref: 'AWS::Region' },
            ':',
            { Ref: 'AWS::AccountId' },
            ':',
            { Ref: apiId },
            '/*/GET/items',
          ],
        ],
      },
    });
    template.resourceCountIs('AWS::SSM::Parameter', 2);
  });

  it('reports the version and the API URL as stack outputs', () => {
    template.hasOutput('Version', { Value: '1.2.3' });
    template.hasOutput('ApiUrl', { Value: Match.anyValue() });
  });

  it('has no output that contains the account ID', () => {
    // The deploy job prints the outputs to a public log.
    expect(JSON.stringify(template.findOutputs('*'))).not.toContain('AWS::AccountId');
  });
});
