import crypto from 'crypto';
import { z } from 'zod';
import { ProviderLogModel, ProviderId, ProviderMode } from '../../models';
import {
  AIProvider,
  AgentInput,
  AgentResponse,
  AgentToolDefinition,
  ProviderConfigError,
  ProviderHealth,
  ProviderTransientError,
} from './AIProvider';
import { GeminiProvider } from './GeminiProvider';
import { GroqProvider } from './GroqProvider';

export interface FailoverEvent {
  from: ProviderId;
  to: ProviderId;
  reason: string;
}

export class ProviderManager {
  private providers: Map<ProviderId, AIProvider>;
  private healthState = new Map<ProviderId, { healthy: boolean; lastFailureAt?: number }>();
  private readonly cooldownMs = 60_000;
  private simulatedOutage: ProviderId | null = null;

  constructor(gemini: AIProvider, groq: AIProvider) {
    this.providers = new Map<ProviderId, AIProvider>([
      ['gemini', gemini],
      ['groq', groq],
    ]);
    this.healthState.set('gemini', { healthy: true });
    this.healthState.set('groq', { healthy: true });
  }

  getSimulatedOutage(): ProviderId | null {
    return this.simulatedOutage;
  }

  setSimulatedOutage(provider: ProviderId | null): void {
    this.simulatedOutage = provider;
  }

  getProvider(id: ProviderId): AIProvider {
    return this.providers.get(id)!;
  }

  private getExecutionOrder(mode: ProviderMode, preferred: ProviderId = 'gemini'): ProviderId[] {
    if (mode === 'gemini_only') return ['gemini'];
    if (mode === 'groq_only') return ['groq'];

    const secondary: ProviderId = preferred === 'gemini' ? 'groq' : 'gemini';
    const primaryState = this.healthState.get(preferred);
    const inCooldown =
      primaryState &&
      !primaryState.healthy &&
      primaryState.lastFailureAt &&
      Date.now() - primaryState.lastFailureAt < this.cooldownMs;

    if (inCooldown && this.providers.get(secondary)?.isConfigured()) {
      return [secondary, preferred];
    }

    return [preferred, secondary];
  }

  private logEvent(params: {
    userId?: string;
    eventType: 'completion' | 'failover' | 'health_check' | 'error';
    provider: ProviderId;
    fallbackTo?: ProviderId;
    model: string;
    latencyMs: number;
    detail: string;
  }) {
    void ProviderLogModel.create({
      _id: crypto.randomUUID(),
      userId: params.userId,
      eventType: params.eventType,
      provider: params.provider,
      fallbackTo: params.fallbackTo,
      model: params.model,
      latencyMs: params.latencyMs,
      detail: params.detail,
    }).catch((err) => console.error('Failed to persist provider log:', err));
  }

  async executeWithFailover<T>(
    options: {
      mode: ProviderMode;
      preferred?: ProviderId;
      userId?: string;
      onSwitch?: (evt: FailoverEvent) => void;
    },
    fn: (provider: AIProvider) => Promise<T>
  ): Promise<{ result: T; usedProvider: ProviderId; switched?: FailoverEvent }> {
    const order = this.getExecutionOrder(options.mode, options.preferred ?? 'gemini');
    let lastError: unknown;
    let switched: FailoverEvent | undefined;

    for (let i = 0; i < order.length; i++) {
      const providerId = order[i];
      const provider = this.providers.get(providerId)!;
      const hasFallback = i + 1 < order.length;

      try {
        if (this.simulatedOutage === providerId) {
          throw new ProviderTransientError(
            providerId,
            `Simulated transient outage (503) on ${provider.label}.`,
            503
          );
        }

        if (!provider.isConfigured()) {
          if (options.mode === 'automatic' && hasFallback) {
            throw new ProviderTransientError(
              providerId,
              `${provider.label} API key is not configured.`,
              503
            );
          }
          throw new ProviderConfigError(providerId, `${provider.label} API key is not configured.`);
        }

        const start = Date.now();
        const result = await fn(provider);
        const resolvedModel =
          (result && typeof result === 'object' && 'model' in result && typeof (result as any).model === 'string'
            ? (result as any).model
            : provider.model);
        this.healthState.set(providerId, { healthy: true });
        this.logEvent({
          userId: options.userId,
          eventType: 'completion',
          provider: providerId,
          model: resolvedModel,
          latencyMs: Date.now() - start,
          detail: `Completed request via ${provider.label} (${resolvedModel})`,
        });

        return { result, usedProvider: providerId, switched };
      } catch (err) {
        lastError = err;
        const canFailover =
          options.mode === 'automatic' && hasFallback && err instanceof ProviderTransientError;

        if (canFailover) {
          const nextId = order[i + 1];
          const nextProvider = this.providers.get(nextId)!;
          if (!nextProvider.isConfigured()) {
            throw err;
          }

          this.healthState.set(providerId, {
            healthy: false,
            lastFailureAt: Date.now(),
          });

          switched = {
            from: providerId,
            to: nextId,
            reason: err.message,
          };
          this.logEvent({
            userId: options.userId,
            eventType: 'failover',
            provider: providerId,
            fallbackTo: nextId,
            model: provider.model,
            latencyMs: 0,
            detail: `Failover ${providerId} -> ${nextId}: ${err.message}`,
          });
          options.onSwitch?.(switched);
          continue;
        }

        this.logEvent({
          userId: options.userId,
          eventType: 'error',
          provider: providerId,
          model: provider.model,
          latencyMs: 0,
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    throw lastError;
  }

  generateWithTools(
    input: AgentInput,
    tools: AgentToolDefinition[],
    options: {
      mode: ProviderMode;
      preferred?: ProviderId;
      userId?: string;
      onSwitch?: (evt: FailoverEvent) => void;
    }
  ): Promise<{ result: AgentResponse; usedProvider: ProviderId; switched?: FailoverEvent }> {
    return this.executeWithFailover(options, (p) => p.generateWithTools(input, tools));
  }

  streamWithTools(
    input: AgentInput,
    tools: AgentToolDefinition[],
    onToken: (token: string) => void,
    options: {
      mode: ProviderMode;
      preferred?: ProviderId;
      userId?: string;
      onSwitch?: (evt: FailoverEvent) => void;
    }
  ): Promise<{ result: AgentResponse; usedProvider: ProviderId; switched?: FailoverEvent }> {
    let emittedAny = false;
    return this.executeWithFailover(options, async (p) => {
      try {
        return await p.streamWithTools(input, tools, (tok) => {
          emittedAny = true;
          onToken(tok);
        });
      } catch (err) {
        // Prevent switching providers mid-sentence after tokens were already streamed
        if (emittedAny && err instanceof ProviderTransientError) {
          throw new ProviderConfigError(p.id, err.message);
        }
        throw err;
      }
    });
  }

  streamText(
    input: AgentInput,
    onToken: (token: string) => void,
    options: {
      mode: ProviderMode;
      preferred?: ProviderId;
      userId?: string;
      onSwitch?: (evt: FailoverEvent) => void;
    }
  ): Promise<{ result: AgentResponse; usedProvider: ProviderId; switched?: FailoverEvent }> {
    return this.executeWithFailover(options, (p) => p.streamText(input, onToken));
  }

  generateStructured<T extends z.ZodTypeAny>(
    input: AgentInput,
    schema: T,
    options: {
      mode: ProviderMode;
      preferred?: ProviderId;
      userId?: string;
    }
  ): Promise<{ result: z.infer<T>; usedProvider: ProviderId; switched?: FailoverEvent }> {
    return this.executeWithFailover(options, (p) => p.generateStructured(input, schema));
  }

  async checkAllHealth(userId?: string): Promise<ProviderHealth[]> {
    const results = await Promise.all([
      this.providers.get('gemini')!.checkHealth(),
      this.providers.get('groq')!.checkHealth(),
    ]);
    for (const r of results) {
      if (this.simulatedOutage === r.provider) {
        r.healthy = false;
        r.error = 'Simulated outage active';
      }
      this.logEvent({
        userId,
        eventType: 'health_check',
        provider: r.provider,
        model: r.model,
        latencyMs: r.latencyMs,
        detail: r.healthy ? `Healthy (${r.latencyMs}ms)` : r.error || 'Unhealthy',
      });
    }
    return results;
  }
}

export const providerManager = new ProviderManager(new GeminiProvider(), new GroqProvider());
