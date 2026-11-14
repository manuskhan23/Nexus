import mongoose, { Schema, Document } from 'mongoose';
import Redis from 'ioredis';
import { env } from '../config/env';
import { hashPassword } from '../services/auth/crypto';

export type ProviderId = 'gemini' | 'groq';
export type ProviderMode = 'automatic' | 'gemini_only' | 'groq_only';

export interface UserDoc extends Document<string> {
  _id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  isEmailVerified: boolean;
  preferences: {
    theme: 'light' | 'dark' | 'system';
    defaultProviderMode: ProviderMode;
    preferredProvider: ProviderId;
    autoExecuteLowRisk: boolean;
    requireApprovalForModerate: boolean;
    autoLearnFromErrors: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDoc>(
  {
    _id: { type: String, required: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    passwordHash: { type: String, required: true },
    isEmailVerified: { type: Boolean, default: false },
    preferences: {
      theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
      defaultProviderMode: {
        type: String,
        enum: ['automatic', 'gemini_only', 'groq_only'],
        default: 'automatic',
      },
      preferredProvider: { type: String, enum: ['gemini', 'groq'], default: 'gemini' },
      autoExecuteLowRisk: { type: Boolean, default: true },
      requireApprovalForModerate: { type: Boolean, default: true },
      autoLearnFromErrors: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

const OtpTokenSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, index: true },
    purpose: { type: String, enum: ['email_verification', 'password_reset'], required: true },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

const RefreshSessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    userAgent: { type: String },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

const ConversationSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    title: { type: String, default: 'New Conversation' },
    providerMode: {
      type: String,
      enum: ['automatic', 'gemini_only', 'groq_only'],
      default: 'automatic',
    },
    activeProvider: { type: String, enum: ['gemini', 'groq'], default: 'gemini' },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

const MessageSchema = new Schema(
  {
    _id: { type: String, required: true },
    conversationId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, default: '' },
    provider: { type: String, enum: ['gemini', 'groq'] },
    model: { type: String },
    latencyMs: { type: Number },
    providerSwitched: {
      type: new Schema(
        {
          from: { type: String },
          to: { type: String },
          reason: { type: String },
        },
        { _id: false }
      ),
      default: undefined,
    },
    toolCalls: { type: [Schema.Types.Mixed], default: [] },
    taskId: { type: String },
    feedback: {
      rating: { type: String, enum: ['good', 'error'] },
      note: { type: String },
      lessonId: { type: String },
      updatedAt: { type: Date },
    },
  },
  { timestamps: true }
);

const TaskSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    conversationId: { type: String },
    messageId: { type: String },
    goal: { type: String, required: true },
    status: {
      type: String,
      enum: [
        'pending',
        'planning',
        'running',
        'awaiting_approval',
        'paused',
        'completed',
        'partially_completed',
        'failed',
        'cancelled',
      ],
      default: 'pending',
    },
    providerMode: {
      type: String,
      enum: ['automatic', 'gemini_only', 'groq_only'],
      default: 'automatic',
    },
    activeProvider: { type: String, enum: ['gemini', 'groq'], default: 'gemini' },
    currentStepIndex: { type: Number, default: 0 },
    finalReport: { type: String, default: '' },
    error: { type: String },
    steps: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

const MemorySchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: String, required: true },
    category: { type: String, enum: ['preference', 'fact', 'workflow'], default: 'fact' },
    source: { type: String, enum: ['user', 'agent'], default: 'user' },
  },
  { timestamps: true }
);

const ProviderLogSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, index: true },
    eventType: {
      type: String,
      enum: ['completion', 'failover', 'health_check', 'error'],
      required: true,
    },
    provider: { type: String, enum: ['gemini', 'groq'], required: true },
    fallbackTo: { type: String, enum: ['gemini', 'groq'] },
    model: { type: String, required: true },
    latencyMs: { type: Number, default: 0 },
    detail: { type: String, required: true },
  },
  { timestamps: true }
);

const TrainingLessonSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    source: {
      type: String,
      enum: ['user_correction', 'ai_error', 'tool_error', 'command'],
      required: true,
    },
    triggerPattern: { type: String, required: true, trim: true },
    mistakeSummary: { type: String, required: true, trim: true },
    learnedRule: { type: String, required: true, trim: true },
    exampleCorrection: { type: String, default: '' },
    confidence: { type: Number, default: 1, min: 1, max: 20 },
    timesApplied: { type: Number, default: 0 },
    active: { type: Boolean, default: true, index: true },
    conversationId: { type: String },
    messageId: { type: String },
  },
  { timestamps: true }
);

const ConnectorSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: ['catalog', 'custom_api', 'mcp_server', 'composio_oauth'],
      required: true,
    },
    slug: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    baseUrl: { type: String, default: '' },
    healthPath: { type: String, default: '' },
    authType: {
      type: String,
      enum: ['bearer', 'api_key_header', 'basic', 'webhook', 'oauth', 'none'],
      default: 'bearer',
    },
    authHeaderName: { type: String, default: '' },
    extraConfig: { type: Schema.Types.Mixed, default: {} },
    encryptedSecret: { type: Schema.Types.Mixed },
    secretHint: { type: String, default: '' },
    status: {
      type: String,
      enum: ['connected', 'error', 'paused'],
      default: 'connected',
    },
    lastTestedAt: { type: Date },
    lastLatencyMs: { type: Number, default: 0 },
    lastTestMessage: { type: String, default: '' },
    discoveredTools: { type: [Schema.Types.Mixed], default: [] },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

export const UserModel = mongoose.models.User || mongoose.model<UserDoc>('User', UserSchema);
export const OtpTokenModel =
  mongoose.models.OtpToken || mongoose.model('OtpToken', OtpTokenSchema);
export const RefreshSessionModel =
  mongoose.models.RefreshSession || mongoose.model('RefreshSession', RefreshSessionSchema);
export const ConversationModel =
  mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema);
export const MessageModel =
  mongoose.models.Message || mongoose.model('Message', MessageSchema);
export const TaskModel = mongoose.models.Task || mongoose.model('Task', TaskSchema);
export const MemoryModel = mongoose.models.Memory || mongoose.model('Memory', MemorySchema);
export const ProviderLogModel =
  mongoose.models.ProviderLog || mongoose.model('ProviderLog', ProviderLogSchema);
export const TrainingLessonModel =
  mongoose.models.TrainingLesson || mongoose.model('TrainingLesson', TrainingLessonSchema);
export const ConnectorModel =
  mongoose.models.Connector || mongoose.model('Connector', ConnectorSchema);

let redisClient: Redis | null = null;
export function getRedis(): Redis | null {
  return redisClient;
}

export async function connectInfrastructure(): Promise<{
  mongoConnected: boolean;
  redisConnected: boolean;
}> {
  let mongoConnected = false;
  let redisConnected = false;

  if (env.MONGODB_URI) {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    mongoConnected = mongoose.connection.readyState === 1;
    console.log('Connected to MongoDB Atlas');

    // Seed demo workspace user if empty
    const existingDemo = await UserModel.findOne({ email: 'demo@nexus.ai' }).lean();
    if (!existingDemo) {
      const demoId = crypto.randomUUID();
      await UserModel.create({
        _id: demoId,
        fullName: 'Alex Mercer',
        email: 'demo@nexus.ai',
        passwordHash: await hashPassword('NexusDemo123'),
        isEmailVerified: true,
        preferences: {
          theme: 'system',
          defaultProviderMode: env.AI_PROVIDER_MODE,
          preferredProvider: env.DEFAULT_AI_PROVIDER,
          autoExecuteLowRisk: true,
          requireApprovalForModerate: true,
        },
      });
      await MemoryModel.insertMany([
        {
          _id: crypto.randomUUID(),
          userId: demoId,
          key: 'preferred_stack',
          value: 'TypeScript, React, Tailwind CSS, and Node.js Express',
          category: 'preference',
          source: 'user',
        },
        {
          _id: crypto.randomUUID(),
          userId: demoId,
          key: 'response_style',
          value: 'Concise engineering summaries with runnable code examples',
          category: 'preference',
          source: 'user',
        },
      ]);
    }
  }

  if (env.REDIS_URL) {
    if (!/^rediss?:\/\//i.test(env.REDIS_URL)) {
      console.warn('REDIS_URL does not use redis:// or rediss:// scheme; continuing without Redis.');
    } else {
      let candidate: Redis | null = null;
      try {
        candidate = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 2,
          connectTimeout: 5000,
          lazyConnect: true,
          retryStrategy: (times) => (times <= 2 ? Math.min(times * 250, 1000) : null),
        });
        candidate.on('error', (err) => {
          console.warn('Redis client warning:', err.message);
        });
        await candidate.connect();
        await candidate.ping();
        redisClient = candidate;
        redisConnected = true;
        console.log('Connected to Upstash Redis');
      } catch (err) {
        console.warn(
          'Redis connection unavailable, continuing without Redis:',
          err instanceof Error ? err.message : String(err)
        );
        try {
          candidate?.disconnect();
        } catch {
          // Ignore disconnect errors
        }
        redisClient = null;
      }
    }
  }

  return { mongoConnected, redisConnected };
}
