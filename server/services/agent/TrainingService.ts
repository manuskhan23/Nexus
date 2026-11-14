import crypto from 'crypto';
import { z } from 'zod';
import {
  MemoryModel,
  MessageModel,
  ProviderMode,
  TrainingLessonModel,
  UserDoc,
} from '../../models';
import { providerManager } from '../ai/FailoverManager';

export type LessonSource = 'user_correction' | 'ai_error' | 'tool_error' | 'command';

const DistilledLessonSchema = z.object({
  triggerPattern: z.string().min(2).max(160),
  mistakeSummary: z.string().min(2).max(500),
  learnedRule: z.string().min(4).max(800),
  exampleCorrection: z.string().max(800).default(''),
});

const BatchLessonsSchema = z.object({
  lessons: z.array(DistilledLessonSchema).min(1).max(30),
});

const ConversationAnalysisSchema = z.object({
  lessons: z
    .array(
      z.object({
        source: z.enum(['user_correction', 'ai_error', 'tool_error']),
        triggerPattern: z.string().min(2).max(160),
        mistakeSummary: z.string().min(2).max(500),
        learnedRule: z.string().min(4).max(800),
        exampleCorrection: z.string().max(800).default(''),
      })
    )
    .max(3),
  summary: z.string().min(2).max(400),
});

function serializeLesson(doc: any) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const { _id, ...rest } = obj;
  return { id: _id, ...rest };
}

export async function recordOrReinforceLesson(params: {
  userId: string;
  source: LessonSource;
  triggerPattern: string;
  mistakeSummary: string;
  learnedRule: string;
  exampleCorrection?: string;
  conversationId?: string;
  messageId?: string;
}) {
  const normalizedTrigger = params.triggerPattern.trim().slice(0, 160);
  const existing = await TrainingLessonModel.findOne({
    userId: params.userId,
    active: true,
    $or: [
      { triggerPattern: new RegExp(`^${normalizedTrigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      { learnedRule: params.learnedRule.trim() },
    ],
  });

  if (existing) {
    existing.confidence = Math.min(20, (existing.confidence || 1) + 1);
    existing.mistakeSummary = params.mistakeSummary.trim().slice(0, 500);
    existing.learnedRule = params.learnedRule.trim().slice(0, 800);
    if (params.exampleCorrection) {
      existing.exampleCorrection = params.exampleCorrection.trim().slice(0, 800);
    }
    await existing.save();
    return { lesson: serializeLesson(existing), reinforced: true };
  }

  const created = await TrainingLessonModel.create({
    _id: crypto.randomUUID(),
    userId: params.userId,
    source: params.source,
    triggerPattern: normalizedTrigger,
    mistakeSummary: params.mistakeSummary.trim().slice(0, 500),
    learnedRule: params.learnedRule.trim().slice(0, 800),
    exampleCorrection: (params.exampleCorrection || '').trim().slice(0, 800),
    confidence: 1,
    timesApplied: 0,
    active: true,
    conversationId: params.conversationId,
    messageId: params.messageId,
  });

  return { lesson: serializeLesson(created), reinforced: false };
}

export async function bulkRecordOrReinforceLessons(params: {
  userId: string;
  source: LessonSource;
  items: Array<{
    triggerPattern: string;
    mistakeSummary: string;
    learnedRule: string;
    exampleCorrection?: string;
  }>;
  conversationId?: string;
}): Promise<{ saved: any[]; createdCount: number; reinforcedCount: number }> {
  if (params.items.length === 0) {
    return { saved: [], createdCount: 0, reinforcedCount: 0 };
  }

  const existingDocs = await TrainingLessonModel.find({
    userId: params.userId,
    active: true,
  }).lean();

  const byTrigger = new Map<string, any>();
  const byRule = new Map<string, any>();
  for (const doc of existingDocs as any[]) {
    byTrigger.set(String(doc.triggerPattern || '').toLowerCase(), doc);
    byRule.set(String(doc.learnedRule || '').toLowerCase(), doc);
  }

  const toInsert: any[] = [];
  const bulkUpdates: any[] = [];
  const saved: any[] = [];
  let reinforcedCount = 0;

  for (const item of params.items) {
    const trigger = item.triggerPattern.trim().slice(0, 160);
    const mistake = item.mistakeSummary.trim().slice(0, 500);
    const rule = item.learnedRule.trim().slice(0, 800);
    const example = (item.exampleCorrection || '').trim().slice(0, 800);
    if (trigger.length < 2 || rule.length < 4) continue;

    const match = byTrigger.get(trigger.toLowerCase()) || byRule.get(rule.toLowerCase());
    if (match) {
      reinforcedCount += 1;
      const nextConf = Math.min(20, (match.confidence || 1) + 1);
      match.confidence = nextConf;
      match.mistakeSummary = mistake;
      match.learnedRule = rule;
      if (example) match.exampleCorrection = example;

      bulkUpdates.push({
        updateOne: {
          filter: { _id: match._id, userId: params.userId },
          update: {
            $set: {
              confidence: nextConf,
              mistakeSummary: mistake,
              learnedRule: rule,
              ...(example ? { exampleCorrection: example } : {}),
            },
          },
        },
      });
      saved.push(serializeLesson(match));
    } else {
      const doc = {
        _id: crypto.randomUUID(),
        userId: params.userId,
        source: params.source,
        triggerPattern: trigger,
        mistakeSummary: mistake || trigger,
        learnedRule: rule,
        exampleCorrection: example,
        confidence: 1,
        timesApplied: 0,
        active: true,
        conversationId: params.conversationId,
      };
      byTrigger.set(trigger.toLowerCase(), doc);
      byRule.set(rule.toLowerCase(), doc);
      toInsert.push(doc);
      saved.push(serializeLesson(doc));
    }
  }

  if (bulkUpdates.length > 0) {
    await TrainingLessonModel.bulkWrite(bulkUpdates);
  }
  if (toInsert.length > 0) {
    await TrainingLessonModel.insertMany(toInsert);
  }

  return {
    saved,
    createdCount: toInsert.length,
    reinforcedCount,
  };
}

function cleanTrailingSectionHeader(text: string): string {
  // Strip trailing numbered section headers like "2. JavaScript and asynchronous programming Lessons 8–15"
  return text
    .replace(/\s+\d+\.\s+[A-Z][^.!?\n]{3,80}\s+Lessons?\s+\d+[–-]\d+\s*$/i, '')
    .replace(/\s+\d+\.\s+[A-Z][^.!?\n]{3,80}\s+Lesson\s+\d+\s*$/i, '')
    .trim();
}

/**
 * Deterministically parses structured datasets in formats like:
 * "Lesson 1: Title - Trigger: ... - Mistake: ... - Rule: ... - Example: ..."
 * Works whether the pasted text is multi-line OR flattened onto a single line.
 */
function parseExplicitLessonsFromText(raw: string): {
  parsed: Array<{
    triggerPattern: string;
    mistakeSummary: string;
    learnedRule: string;
    exampleCorrection: string;
  }>;
  leftoverText: string;
} {
  const lessonHeaderRegex = /\bLesson\s+\d+\s*:\s*/gi;
  const matches = Array.from(raw.matchAll(lessonHeaderRegex));
  if (matches.length === 0) {
    return { parsed: [], leftoverText: raw };
  }

  const parsed: Array<{
    triggerPattern: string;
    mistakeSummary: string;
    learnedRule: string;
    exampleCorrection: string;
  }> = [];

  const firstStart = matches[0].index ?? 0;
  let leftoverChunks: string[] = [];
  if (firstStart > 0) {
    leftoverChunks.push(raw.slice(0, firstStart).trim());
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const contentStart = start + matches[i][0].length;
    let end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;

    let block = raw.slice(contentStart, end);

    // For the final Lesson block, detect trailing numbered section like "9. Additional advanced rules..." or "10. Important..."
    if (i === matches.length - 1) {
      const trailingSectionMatch = block.match(
        /\s+(\d+\.\s+(?:Additional|Important|Advanced|Summary|Notes|Next)\b[\s\S]*)$/i
      );
      if (trailingSectionMatch && trailingSectionMatch.index !== undefined) {
        leftoverChunks.push(trailingSectionMatch[1].trim());
        block = block.slice(0, trailingSectionMatch.index);
      }
    }

    const triggerMatch = block.match(/(?:^|\s-\s*|\n\s*-\s*)Trigger\s*:\s*/i);
    const mistakeMatch = block.match(/(?:\s-\s*|\n\s*-\s*)Mistake\s*:\s*/i);
    const ruleMatch = block.match(/(?:\s-\s*|\n\s*-\s*)Rule\s*:\s*/i);
    const exampleMatch = block.match(/(?:\s-\s*|\n\s*-\s*)Example\s*:\s*/i);

    if (!ruleMatch || ruleMatch.index === undefined) continue;

    const title = triggerMatch?.index !== undefined
      ? block.slice(0, triggerMatch.index).trim()
      : block.slice(0, mistakeMatch?.index ?? ruleMatch.index).trim();

    const triggerStart =
      triggerMatch?.index !== undefined ? triggerMatch.index + triggerMatch[0].length : -1;
    const triggerEnd = mistakeMatch?.index ?? ruleMatch.index;
    const triggerBody = triggerStart >= 0 ? block.slice(triggerStart, triggerEnd).trim() : '';

    const mistakeStart =
      mistakeMatch?.index !== undefined ? mistakeMatch.index + mistakeMatch[0].length : -1;
    const mistakeEnd = ruleMatch.index;
    const mistakeBody = mistakeStart >= 0 ? block.slice(mistakeStart, mistakeEnd).trim() : '';

    const ruleStart = ruleMatch.index + ruleMatch[0].length;
    const ruleEnd = exampleMatch?.index ?? block.length;
    const ruleBody = cleanTrailingSectionHeader(block.slice(ruleStart, ruleEnd).trim());

    const exampleStart =
      exampleMatch?.index !== undefined ? exampleMatch.index + exampleMatch[0].length : -1;
    const exampleBody =
      exampleStart >= 0 ? cleanTrailingSectionHeader(block.slice(exampleStart).trim()) : '';

    const triggerPattern = title
      ? `${title}${triggerBody ? ` (${triggerBody.replace(/\.$/, '')})` : ''}`.slice(0, 160)
      : triggerBody.slice(0, 160);

    if (ruleBody.length >= 4) {
      parsed.push({
        triggerPattern: triggerPattern || 'General best practice',
        mistakeSummary: mistakeBody || `Avoid anti-pattern in ${title || 'workflow'}`,
        learnedRule: ruleBody,
        exampleCorrection: exampleBody,
      });
    }
  }

  return {
    parsed,
    leftoverText: leftoverChunks.filter(Boolean).join('\n\n'),
  };
}

function stripNonLessonMetaSections(text: string): string {
  // Ignore trailing informational pipeline diagrams/descriptions if present
  return text
    .replace(/\b\d+\.\s+Important:\s*How NEXUS should use this training data[\s\S]*$/i, '')
    .trim();
}

async function extractLessonsWithLLMChunks(
  user: UserDoc,
  text: string
): Promise<
  Array<{
    triggerPattern: string;
    mistakeSummary: string;
    learnedRule: string;
    exampleCorrection: string;
  }>
> {
  const cleaned = stripNonLessonMetaSections(text);
  if (cleaned.length < 40) return [];

  const chunks: string[] = [];
  const maxChunk = 4200;
  let cursor = 0;
  while (cursor < cleaned.length) {
    let sliceEnd = Math.min(cleaned.length, cursor + maxChunk);
    if (sliceEnd < cleaned.length) {
      const lastBreak = Math.max(
        cleaned.lastIndexOf('\n', sliceEnd),
        cleaned.lastIndexOf('. ', sliceEnd)
      );
      if (lastBreak > cursor + 1500) {
        sliceEnd = lastBreak + 1;
      }
    }
    const piece = cleaned.slice(cursor, sliceEnd).trim();
    if (piece.length >= 30) chunks.push(piece);
    cursor = sliceEnd;
  }

  const collected: Array<{
    triggerPattern: string;
    mistakeSummary: string;
    learnedRule: string;
    exampleCorrection: string;
  }> = [];

  for (const chunk of chunks.slice(0, 6)) {
    try {
      const { result } = await providerManager.generateStructured(
        {
          systemPrompt: [
            'You are the NEXUS Training Dataset Extractor.',
            'Extract EVERY distinct training rule, mistake-correction pair, or topic rule from the user text.',
            'Ignore pure section titles or high-level meta commentary about how the training pipeline works.',
            'Return ONLY JSON matching: {"lessons": [{"triggerPattern": string, "mistakeSummary": string, "learnedRule": string, "exampleCorrection": string}]}.',
          ].join('\n'),
          messages: [{ role: 'user', content: chunk }],
        },
        BatchLessonsSchema,
        {
          mode: user.preferences.defaultProviderMode || 'automatic',
          preferred: user.preferences.preferredProvider,
          userId: user._id,
        }
      );
      collected.push(...result.lessons);
    } catch {
      // Fallback: extract sentence/line items if structured LLM extraction fails on a chunk
      const lines = chunk
        .split(/\n|(?<=\.)\s+(?=[A-Z])/)
        .map((l) => l.trim())
        .filter((l) => l.length >= 25 && l.length <= 450);
      for (const l of lines.slice(0, 10)) {
        collected.push({
          triggerPattern: l.slice(0, 80),
          mistakeSummary: 'Follow trained directive',
          learnedRule: l,
          exampleCorrection: '',
        });
      }
    }
  }

  return collected;
}

export async function distillLessonFromError(params: {
  user: UserDoc;
  source: LessonSource;
  userPrompt: string;
  assistantResponse: string;
  correctionNote: string;
  conversationId?: string;
  messageId?: string;
}) {
  const mode: ProviderMode = params.user.preferences.defaultProviderMode || 'automatic';
  const systemPrompt = [
    'You are the NEXUS Error-Learning & Alignment Distiller.',
    'Analyze the conversation turn and the correction/error note (which may identify a mistake made by the AI OR a mistake made by the user that should be avoided going forward).',
    'Extract ONE concise, actionable rule so NEXUS handles similar requests accurately in the future.',
    'Return ONLY JSON matching: {"triggerPattern": string, "mistakeSummary": string, "learnedRule": string, "exampleCorrection": string}.',
  ].join('\n');

  let distilled: z.infer<typeof DistilledLessonSchema>;
  try {
    const { result } = await providerManager.generateStructured(
      {
        systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              `Source Type: ${params.source}`,
              params.userPrompt ? `User Input:\n${params.userPrompt.slice(0, 1200)}` : '',
              params.assistantResponse ? `Assistant Response:\n${params.assistantResponse.slice(0, 1200)}` : '',
              `Correction / Error Report:\n${params.correctionNote.slice(0, 1500)}`,
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
      },
      DistilledLessonSchema,
      {
        mode,
        preferred: params.user.preferences.preferredProvider,
        userId: params.user._id,
      }
    );
    distilled = result;
  } catch {
    distilled = {
      triggerPattern: params.userPrompt.slice(0, 80) || 'General response accuracy',
      mistakeSummary: params.correctionNote.slice(0, 240),
      learnedRule: `Follow user correction: ${params.correctionNote.slice(0, 380)}`,
      exampleCorrection: '',
    };
  }

  return recordOrReinforceLesson({
    userId: params.user._id,
    source: params.source,
    triggerPattern: distilled.triggerPattern,
    mistakeSummary: distilled.mistakeSummary,
    learnedRule: distilled.learnedRule,
    exampleCorrection: distilled.exampleCorrection,
    conversationId: params.conversationId,
    messageId: params.messageId,
  });
}

export async function recordToolErrorLesson(params: {
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  error: string;
  conversationId?: string;
}) {
  const triggerPattern = `Tool usage: ${params.toolName}`;
  const mistakeSummary = `Tool "${params.toolName}" failed with args ${JSON.stringify(params.args).slice(0, 160)}: ${params.error.slice(0, 180)}`;
  const learnedRule = `When calling "${params.toolName}", avoid triggering "${params.error.slice(0, 140)}". Validate parameter format and types before invoking the tool.`;
  return recordOrReinforceLesson({
    userId: params.userId,
    source: 'tool_error',
    triggerPattern,
    mistakeSummary,
    learnedRule,
    conversationId: params.conversationId,
  });
}

export async function analyzeConversationErrors(params: {
  user: UserDoc;
  conversationId: string;
}) {
  const messages = await MessageModel.find({
    conversationId: params.conversationId,
    userId: params.user._id,
  })
    .sort({ createdAt: -1 })
    .limit(12)
    .lean();

  if (messages.length === 0) {
    return { lessons: [], summary: 'No messages in this conversation to analyze yet.' };
  }

  const ordered = messages.reverse();
  const transcript = ordered
    .map((m: any) => {
      const toolErrors = (m.toolCalls || [])
        .filter((t: any) => t.status === 'failed' || t.error)
        .map((t: any) => `[Tool Error ${t.name}: ${t.error}]`)
        .join(' ');
      const feedbackNote = m.feedback?.note ? ` [Feedback: ${m.feedback.note}]` : '';
      return `${m.role.toUpperCase()}: ${String(m.content || '').slice(0, 700)} ${toolErrors}${feedbackNote}`;
    })
    .join('\n---\n');

  const { result } = await providerManager.generateStructured(
    {
      systemPrompt: [
        'You are the NEXUS Self-Training Analyzer.',
        'Inspect the chat transcript for ANY mistakes made by the user (typos, flawed logic, misconceptions, invalid syntax) OR mistakes/weaknesses made by the AI or tools.',
        'Distill up to 3 concrete, reusable training lessons that will help NEXUS give better, error-free responses in future sessions.',
        'If no errors occurred, distill 1 proactive best-practice lesson from what the user appears to be working on.',
        'Return ONLY JSON: {"summary": string, "lessons": [{"source": "user_correction"|"ai_error"|"tool_error", "triggerPattern": string, "mistakeSummary": string, "learnedRule": string, "exampleCorrection": string}]}.',
      ].join('\n'),
      messages: [{ role: 'user', content: transcript }],
    },
    ConversationAnalysisSchema,
    {
      mode: params.user.preferences.defaultProviderMode || 'automatic',
      preferred: params.user.preferences.preferredProvider,
      userId: params.user._id,
    }
  );

  const saved: any[] = [];
  for (const item of result.lessons) {
    const { lesson } = await recordOrReinforceLesson({
      userId: params.user._id,
      source: item.source,
      triggerPattern: item.triggerPattern,
      mistakeSummary: item.mistakeSummary,
      learnedRule: item.learnedRule,
      exampleCorrection: item.exampleCorrection,
      conversationId: params.conversationId,
    });
    saved.push(lesson);
  }

  return { lessons: saved, summary: result.summary };
}

function tokenizeForMatch(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_+#.-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return new Set(words);
}

export async function getActiveTrainingPromptSection(
  userId: string,
  queryContext?: string
): Promise<{
  promptSection: string;
  lessons: any[];
}> {
  const docs = await TrainingLessonModel.find({ userId, active: true })
    .sort({ confidence: -1, updatedAt: -1 })
    .limit(250)
    .lean();

  if (docs.length === 0) {
    return { promptSection: '', lessons: [] };
  }

  let selectedDocs = docs as any[];
  if (docs.length > 18) {
    if (queryContext && queryContext.trim().length > 0) {
      const qTokens = tokenizeForMatch(queryContext);
      const scored = (docs as any[]).map((d) => {
        const haystack = `${d.triggerPattern} ${d.mistakeSummary} ${d.learnedRule}`.toLowerCase();
        let overlap = 0;
        for (const tok of qTokens) {
          if (haystack.includes(tok)) overlap += 1;
        }
        const score = overlap * 3 + Math.min(5, d.confidence || 1) * 0.4;
        return { doc: d, score };
      });
      scored.sort((a, b) => b.score - a.score);
      selectedDocs = scored.slice(0, 18).map((s) => s.doc);
    } else {
      selectedDocs = docs.slice(0, 18) as any[];
    }
  }

  const ids = selectedDocs.map((d: any) => d._id);
  void TrainingLessonModel.updateMany({ _id: { $in: ids } }, { $inc: { timesApplied: 1 } }).catch(
    () => undefined
  );

  const lines = selectedDocs.map(
    (d: any, idx: number) =>
      `${idx + 1}. [When: ${d.triggerPattern}] Rule: ${d.learnedRule}${
        d.exampleCorrection ? ` (Example: ${String(d.exampleCorrection).slice(0, 160)})` : ''
      }`
  );

  return {
    promptSection: `Learned Training Rules & Error Corrections (${selectedDocs.length} of ${docs.length} active rules injected — ALWAYS FOLLOW):\n${lines.join('\n')}`,
    lessons: selectedDocs.map(serializeLesson),
  };
}

export interface CommandExecutionResult {
  handled: boolean;
  command: string;
  replyMarkdown: string;
  lessonsAffected: any[];
  ok: boolean;
}

export const SUPPORTED_TRAINING_COMMANDS = [
  {
    cmd: '/train <rule or dataset>',
    desc: 'Teach NEXUS a single rule or paste a multi-lesson dataset (Lesson 1..50, tables, or guidelines).',
    example: '/train Always include error handling and edge-case checks in TypeScript examples.',
  },
  {
    cmd: '/correct <mistake> => <fix>',
    desc: 'Train NEXUS from a response error or user mistake (uses recent chat context if omitted).',
    example: '/correct Used var instead of const => Always use const by default and let only when reassigned.',
  },
  {
    cmd: '/analyze-errors',
    desc: 'Scan the current conversation for user/AI/tool errors and distill training rules automatically.',
    example: '/analyze-errors',
  },
  {
    cmd: '/lessons',
    desc: 'List all active learned training rules with confidence scores and usage counts.',
    example: '/lessons',
  },
  {
    cmd: '/forget <keyword>',
    desc: 'Deactivate or remove learned rules matching a keyword or rule ID.',
    example: '/forget var instead',
  },
  {
    cmd: '/test <prompt>',
    desc: 'Test how NEXUS responds right now using your active trained rules and memory.',
    example: '/test Write a short TypeScript fetch helper.',
  },
  {
    cmd: '/help',
    desc: 'Show all supported training slash commands.',
    example: '/help',
  },
];

export async function executeTrainingCommand(params: {
  user: UserDoc;
  rawCommand: string;
  conversationId?: string;
}): Promise<CommandExecutionResult> {
  const trimmed = params.rawCommand.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false, command: '', replyMarkdown: '', lessonsAffected: [], ok: false };
  }

  const matchCmd = trimmed.match(/^(\/[a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  const command = (matchCmd?.[1] || trimmed).toLowerCase();
  const arg = (matchCmd?.[2] || '').trim();

  if (command === '/help' || command === '/cmds') {
    const lines = SUPPORTED_TRAINING_COMMANDS.map(
      (c) => `- \`${c.cmd}\` — ${c.desc}\n  Example: \`${c.example}\``
    );
    return {
      handled: true,
      command,
      ok: true,
      lessonsAffected: [],
      replyMarkdown: `### NEXUS Training Commands\n\n${lines.join('\n')}`,
    };
  }

  if (command === '/lessons' || command === '/rules') {
    const lessons = await TrainingLessonModel.find({ userId: params.user._id, active: true })
      .sort({ confidence: -1, updatedAt: -1 })
      .limit(50)
      .lean();
    if (lessons.length === 0) {
      return {
        handled: true,
        command,
        ok: true,
        lessonsAffected: [],
        replyMarkdown:
          'No active training rules yet. Use `/train <rule>` or `/correct <mistake> => <fix>` to teach NEXUS.',
      };
    }
    const lines = lessons.map(
      (l: any, idx: number) =>
        `${idx + 1}. **[${l.triggerPattern}]** (${l.source}, confidence ${l.confidence}, applied ${l.timesApplied}x)\n   - Rule: ${l.learnedRule}`
    );
    return {
      handled: true,
      command,
      ok: true,
      lessonsAffected: lessons.map(serializeLesson),
      replyMarkdown: `### Active Training Rules (${lessons.length})\n\n${lines.join('\n')}`,
    };
  }

  if (command === '/train' || command === '/learn-rule') {
    if (!arg || arg.length < 4) {
      return {
        handled: true,
        command,
        ok: false,
        lessonsAffected: [],
        replyMarkdown: 'Please provide a training instruction after `/train`, e.g. `/train Always answer with concise bullet points.`',
      };
    }

    // Large or structured dataset handling (Lesson 1..50, tables, multi-paragraph guidelines)
    const hasExplicitLessons = /\bLesson\s+\d+\s*:/i.test(arg);
    if (hasExplicitLessons || arg.length > 350) {
      const { parsed, leftoverText } = parseExplicitLessonsFromText(arg);
      const llmExtracted = await extractLessonsWithLLMChunks(params.user, leftoverText);
      const combined = [...parsed, ...llmExtracted];

      if (combined.length > 0) {
        const { saved, createdCount, reinforcedCount } = await bulkRecordOrReinforceLessons({
          userId: params.user._id,
          source: 'command',
          items: combined,
          conversationId: params.conversationId,
        });

        const preview = saved
          .slice(0, 8)
          .map((l, idx) => `${idx + 1}. **${l.triggerPattern}** — ${l.learnedRule.slice(0, 120)}`)
          .join('\n');

        return {
          handled: true,
          command: '/train (dataset)',
          ok: true,
          lessonsAffected: saved,
          replyMarkdown: [
            `### Bulk Training Complete (${saved.length} lessons processed)`,
            `- **New rules saved**: ${createdCount}`,
            `- **Existing rules reinforced**: ${reinforcedCount}`,
            saved.length > 0 ? `\n**Sample Learned Rules:**\n${preview}` : '',
            saved.length > 8 ? `\n*...and ${saved.length - 8} more rules saved to MongoDB.*` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }
    }

    const { lesson, reinforced } = await distillLessonFromError({
      user: params.user,
      source: 'command',
      userPrompt: `Command training instruction: ${arg}`,
      assistantResponse: '',
      correctionNote: `Direct training command rule from user: ${arg}`,
      conversationId: params.conversationId,
    });

    return {
      handled: true,
      command,
      ok: true,
      lessonsAffected: [lesson],
      replyMarkdown: [
        `### ${reinforced ? 'Training Rule Reinforced' : 'New Training Rule Saved'}`,
        `- **Trigger**: ${lesson.triggerPattern}`,
        `- **Learned Rule**: ${lesson.learnedRule}`,
        `- **Confidence**: ${lesson.confidence}`,
      ].join('\n'),
    };
  }

  if (command === '/correct' || command === '/fix') {
    if (!arg || arg.length < 3) {
      return {
        handled: true,
        command,
        ok: false,
        lessonsAffected: [],
        replyMarkdown:
          'Provide a correction, e.g. `/correct Missing null check => Always validate nullable inputs before accessing properties.`',
      };
    }

    let lastUserPrompt = '';
    let lastAssistantResponse = '';
    if (params.conversationId) {
      const recent = await MessageModel.find({
        conversationId: params.conversationId,
        userId: params.user._id,
      })
        .sort({ createdAt: -1 })
        .limit(6)
        .lean();
      for (const m of recent) {
        if (!lastAssistantResponse && m.role === 'assistant' && !String(m.content).startsWith('### ')) {
          lastAssistantResponse = String(m.content || '');
        } else if (!lastUserPrompt && m.role === 'user' && !String(m.content).startsWith('/')) {
          lastUserPrompt = String(m.content || '');
        }
      }
    }

    const parts = arg.split('=>');
    const correctionNote =
      parts.length >= 2
        ? `Mistake: ${parts[0].trim()} | Correct Rule/Behavior: ${parts.slice(1).join('=>').trim()}`
        : arg;

    const { lesson, reinforced } = await distillLessonFromError({
      user: params.user,
      source: 'user_correction',
      userPrompt: lastUserPrompt,
      assistantResponse: lastAssistantResponse,
      correctionNote,
      conversationId: params.conversationId,
    });

    return {
      handled: true,
      command,
      ok: true,
      lessonsAffected: [lesson],
      replyMarkdown: [
        `### ${reinforced ? 'Error Lesson Reinforced' : 'Learned From Correction'}`,
        `- **Trigger**: ${lesson.triggerPattern}`,
        `- **Mistake Identified**: ${lesson.mistakeSummary}`,
        `- **Learned Rule**: ${lesson.learnedRule}`,
        lesson.exampleCorrection ? `- **Correction Example**: ${lesson.exampleCorrection}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  if (command === '/analyze-errors' || command === '/learn') {
    if (!params.conversationId) {
      return {
        handled: true,
        command,
        ok: false,
        lessonsAffected: [],
        replyMarkdown:
          'Run `/analyze-errors` inside a conversation or pass a conversationId so NEXUS can inspect the transcript for mistakes.',
      };
    }
    const analysis = await analyzeConversationErrors({
      user: params.user,
      conversationId: params.conversationId,
    });
    const list =
      analysis.lessons.length > 0
        ? analysis.lessons
            .map(
              (l: any, i: number) =>
                `${i + 1}. **${l.triggerPattern}** (${l.source})\n   - Mistake: ${l.mistakeSummary}\n   - Rule: ${l.learnedRule}`
            )
            .join('\n')
        : 'No new rules distilled.';
    return {
      handled: true,
      command,
      ok: true,
      lessonsAffected: analysis.lessons,
      replyMarkdown: `### Self-Training Analysis Complete\n\n${analysis.summary}\n\n${list}`,
    };
  }

  if (command === '/forget' || command === '/unlearn') {
    if (!arg) {
      return {
        handled: true,
        command,
        ok: false,
        lessonsAffected: [],
        replyMarkdown: 'Specify a keyword or rule ID after `/forget`, e.g. `/forget null check`.',
      };
    }
    const regex = new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const matched = await TrainingLessonModel.find({
      userId: params.user._id,
      active: true,
      $or: [{ _id: arg }, { triggerPattern: regex }, { learnedRule: regex }, { mistakeSummary: regex }],
    }).lean();

    if (matched.length === 0) {
      return {
        handled: true,
        command,
        ok: false,
        lessonsAffected: [],
        replyMarkdown: `No active training rules matched "${arg}".`,
      };
    }

    await TrainingLessonModel.updateMany(
      { _id: { $in: matched.map((m: any) => m._id) } },
      { $set: { active: false } }
    );

    return {
      handled: true,
      command,
      ok: true,
      lessonsAffected: matched.map(serializeLesson),
      replyMarkdown: `Deactivated **${matched.length}** training rule(s) matching \`${arg}\`.`,
    };
  }

  if (command === '/test') {
    if (!arg) {
      return {
        handled: true,
        command,
        ok: false,
        lessonsAffected: [],
        replyMarkdown: 'Provide a test prompt after `/test`, e.g. `/test Format a JSON config helper.`',
      };
    }

    const [{ promptSection, lessons }, memories] = await Promise.all([
      getActiveTrainingPromptSection(params.user._id, arg),
      MemoryModel.find({ userId: params.user._id }).sort({ updatedAt: -1 }).limit(10).lean(),
    ]);
    const memLines = memories.map((m: any) => `- [${m.category}] ${m.key}: ${m.value}`).join('\n');
    const systemPrompt = [
      'You are NEXUS. Strictly follow all Learned Training Rules and User Memory below.',
      promptSection,
      memLines ? `User Persistent Memory:\n${memLines}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const { result, usedProvider } = await providerManager.generateWithTools(
      { systemPrompt, messages: [{ role: 'user', content: arg }] },
      [],
      {
        mode: params.user.preferences.defaultProviderMode || 'automatic',
        preferred: params.user.preferences.preferredProvider,
        userId: params.user._id,
      }
    );

    return {
      handled: true,
      command,
      ok: true,
      lessonsAffected: lessons,
      replyMarkdown: [
        `### Training Verification Test (${usedProvider} · ${result.model})`,
        `*Applied ${lessons.length} relevant active training rule(s)*\n`,
        result.content || '(empty response)',
      ].join('\n'),
    };
  }

  return {
    handled: true,
    command,
    ok: false,
    lessonsAffected: [],
    replyMarkdown: `Unknown command \`${command}\`. Type \`/help\` to see supported training commands.`,
  };
}

export async function executeTrainingCommandBatch(params: {
  user: UserDoc;
  script: string;
  conversationId?: string;
}) {
  const trimmedScript = params.script.trim();
  const lines = trimmedScript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  // Count lines that explicitly begin with a training slash command
  const slashCommandPattern =
    /^\/(train|learn-rule|correct|fix|analyze-errors|learn|lessons|rules|forget|unlearn|test|help|cmds)\b/i;
  const commandLines = lines.filter((l) => slashCommandPattern.test(l));

  // If the entire multi-line paste is a single /train dataset (e.g., /train followed by 50 lessons or code blocks),
  // execute it as ONE dataset import rather than splitting code lines into separate commands.
  if (
    /\bLesson\s+\d+\s*:/i.test(trimmedScript) ||
    (commandLines.length === 1 && /^\/(train|learn-rule)\b/i.test(lines[0] || '')) ||
    (commandLines.length === 0 && trimmedScript.length > 350)
  ) {
    const normalized = trimmedScript.startsWith('/') ? trimmedScript : `/train ${trimmedScript}`;
    const res = await executeTrainingCommand({
      user: params.user,
      rawCommand: normalized,
      conversationId: params.conversationId,
    });
    return [res];
  }

  // Otherwise group multi-line blocks starting at each `/` command
  const commands: string[] = [];
  for (const line of lines) {
    if (line.startsWith('/')) {
      commands.push(line);
    } else if (commands.length > 0) {
      commands[commands.length - 1] += `\n${line}`;
    } else {
      commands.push(`/train ${line}`);
    }
  }

  const results: CommandExecutionResult[] = [];
  for (const cmd of commands) {
    const res = await executeTrainingCommand({
      user: params.user,
      rawCommand: cmd,
      conversationId: params.conversationId,
    });
    results.push(res);
  }
  return results;
}
