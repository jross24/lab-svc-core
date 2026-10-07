import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { instrument } from './instrument.ts';

type JsonResponse = APIGatewayProxyStructuredResultV2 & { readonly statusCode: number; readonly body: string };

const SERVICE = 'core';

// Mock data. A later phase can replace it with a real data store.
const ITEMS = [
  { id: 'item-1', name: 'First item' },
  { id: 'item-2', name: 'Second item' },
  { id: 'item-3', name: 'Third item' },
] as const;

// The one place where the service fails on purpose. The stage config sets INJECT_FAULT for a stage.
// It is a device for the release drill, not a practice for production. See "The Production drill" in the README.
function failOnPurpose(): void {
  if (process.env.INJECT_FAULT === 'true') {
    throw new Error('injected fault: the stage config of this release sets injectFault');
  }
}

async function itemsHandler(): Promise<JsonResponse> {
  failOnPurpose();
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service: SERVICE,
      // The stack sets VERSION at synth time, so the response shows which release runs.
      version: process.env.VERSION ?? 'unknown',
      items: ITEMS,
    }),
  };
}

export const handler = instrument({ service: SERVICE }, itemsHandler);
