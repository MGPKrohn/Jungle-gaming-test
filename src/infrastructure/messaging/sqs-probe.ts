import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { HealthProbe } from '../../application/queries.js';

/** Requer: bun add @aws-sdk/client-sqs */
export function createSqsClient(env: Record<string, string | undefined> = process.env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION ?? 'us-east-1',
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

export class SqsProbe implements HealthProbe {
  readonly name = 'sqs';
  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async check(): Promise<void> {
    await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
  }
}
