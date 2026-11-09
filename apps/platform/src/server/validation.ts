import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './security/password';

export const RESERVED_SLUGS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'login',
  'signup',
  'dashboard',
  'static',
  'assets',
  'livekit',
  'mail',
  'smtp',
  'status',
  'help',
  'support',
  'root',
  'superadmin',
]);

const displayName = z.string().trim().min(1, 'Informe um nome').max(80, 'Nome muito longo');
const email = z.string().trim().toLowerCase().max(254).email('E-mail inválido');
const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A senha precisa de pelo menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(PASSWORD_MAX_LENGTH, 'Senha muito longa');

export const tenantSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'Use letras minúsculas, números e hífen (até 40)')
  .refine((s) => !RESERVED_SLUGS.has(s), 'Este endereço é reservado');

export const roomSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'Use letras minúsculas, números e hífen (até 64)');

export const signupInput = z.object({
  organization: z.string().trim().min(1, 'Informe o nome da organização').max(80),
  slug: tenantSlug,
  name: displayName,
  email,
  password,
});

export const loginInput = z.object({
  email,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const ROOM_ACCESS = ['open', 'trusted', 'restricted'] as const;
export const roomAccess = z.enum(ROOM_ACCESS);
export const COLLAB_POLICIES = ['everyone', 'moderators'] as const;
export const collabPolicy = z.enum(COLLAB_POLICIES);
export const MAX_ROOM_INVITES = 200;
/** The agents in a room (checkboxes); empty means no AI. */
export const roomAgentIds = z.array(z.string().uuid()).max(4, 'Até 4 assistentes de IA por sala');

/** Replaces a room's invite list; duplicates and letter case are folded. */
export const roomInvitesInput = z.object({
  emails: z
    .array(email)
    .max(MAX_ROOM_INVITES, `Até ${MAX_ROOM_INVITES} convidados por sala`)
    .transform((list) => [...new Set(list)]),
});

const roomPassword = z.string().min(4, 'A senha da sala precisa de pelo menos 4 caracteres').max(128);

export const createRoomInput = z.object({
  name: z.string().trim().min(1, 'Informe o nome da sala').max(80),
  slug: roomSlug.optional(),
  password: roomPassword.optional(),
  allowGuests: z.boolean().default(true),
  access: roomAccess.default('trusted'),
  boardPolicy: collabPolicy.default('everyone'),
  pollsPolicy: collabPolicy.default('everyone'),
  thinkingSound: z.boolean().default(true),
  agentActions: z.boolean().default(true),
  agentEnabled: z.boolean().default(false),
  agentId: z.string().uuid().nullable().optional(),
  agentIds: roomAgentIds.optional(),
  maxParticipants: z.number().int().min(2).max(1000).optional(),
});

export const updateRoomInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    password: roomPassword.nullable(),
    allowGuests: z.boolean(),
    access: roomAccess,
    boardPolicy: collabPolicy,
    pollsPolicy: collabPolicy,
    thinkingSound: z.boolean(),
    agentActions: z.boolean(),
    agentEnabled: z.boolean(),
    agentId: z.string().uuid().nullable(),
    agentIds: roomAgentIds,
    maxParticipants: z.number().int().min(2).max(1000).nullable(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nada para alterar');

export const moderationInput = z.object({
  action: z.enum(['mute', 'mute_all', 'remove', 'promote', 'demote']),
  identity: z.string().min(1).max(200).optional(),
});

export const lobbyStatusInput = z.object({
  id: z.string().uuid(),
  secret: z.string().min(20).max(100),
});

const role = z.enum(['admin', 'manager', 'member']);

export const createUserInput = z.object({ name: displayName, email, password, role });

export const updateUserInput = z
  .object({
    name: displayName,
    role,
    status: z.enum(['active', 'disabled']),
    password,
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nada para alterar');

export const brandingInput = z.object({
  productName: z.string().trim().min(1, 'Informe o nome do produto').max(60),
  defaultLocale: z.enum(['pt-BR', 'en', 'es']).default('pt-BR'),
  primaryColor: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Use uma cor no formato #RRGGBB'),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\/[^\s"'<>]+$/, 'O logo precisa ser um endereço https://')
    .nullable(),
});

export const domainInput = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      'Informe um domínio válido, como reuniao.suaempresa.com.br',
    ),
});

export const tenantAdminInput = z
  .object({
    status: z.enum(['active', 'suspended']),
    plan: z.enum(['free', 'pro', 'enterprise']),
    limits: z.record(z.string(), z.unknown()),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nada para alterar');

/** Remove people, mute microphones, answer the waiting room, switch cameras off, record. */
export const AGENT_MODERATION_TOOLS = ['remove', 'mute', 'lobby', 'camera', 'record'] as const;
/** What in the meeting an agent may look at when asked. */
export const AGENT_PERCEPTION = ['board', 'polls', 'screen'] as const;

export const agentModerationInput = z.object({
  room: z.string().min(3).max(200),
  action: z.enum(['remove', 'mute', 'camera', 'admit', 'deny', 'record_start', 'record_stop']),
  /** A participant identity (remove, mute) or a waiting-room request id (admit, deny). */
  target: z.string().min(1).max(200),
  /** The moderator who asked, when someone asked. */
  requestedBy: z.string().min(1).max(200).optional(),
  /** The admin rule the agent applied, when it acted on its own. */
  rule: z.string().trim().max(500).optional(),
});

const voiceRef = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{4,64}$/, 'ID de voz inválido');

export const agentInput = z.object({
  name: z.string().trim().min(1, 'Informe o nome do agente').max(60),
  description: z.string().trim().max(160, 'Descrição muito longa (máx. 160 caracteres)').default(''),
  instructions: z.string().trim().min(1, 'Descreva quem é o agente e como ele deve agir').max(20000),
  knowledge: z
    .string()
    .trim()
    .max(100000, 'Base de conhecimento muito grande (máx. 100 mil caracteres)')
    .default(''),
  greeting: z.string().trim().max(500).default(''),
  /**
   * The speaking provider's voice per language the agent answers in (pt, en, es). Nothing is
   * inherited from the server: providers, models and at least one voice are always chosen here.
   */
  voices: z
    .object(
      { pt: voiceRef.optional(), en: voiceRef.optional(), es: voiceRef.optional() },
      {
        error: 'Informe o ID da voz de pelo menos um idioma',
      },
    )
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'Informe o ID da voz de pelo menos um idioma'),
  ttsModel: z
    .string({ error: 'Escolha o modelo de voz' })
    .trim()
    .regex(/^[a-z0-9._-]{1,40}$/, 'Escolha o modelo de voz'),
  sttModel: z
    .string({ error: 'Escolha o modelo de transcrição' })
    .trim()
    .regex(/^[a-z0-9._-]{1,60}$/, 'Escolha o modelo de transcrição'),
  llmModel: z.string({ error: 'Escolha o modelo de LLM' }).trim().min(1, 'Escolha o modelo de LLM').max(120),
  listenMode: z.enum(['everyone', 'moderators', 'members']).default('everyone'),
  respondMode: z.enum(['always', 'when_named']).default('always'),
  mutePolicy: z.enum(['everyone', 'moderators', 'disabled']).default('everyone'),
  /** What the agent may do to other people in a meeting (nothing unless turned on). */
  moderationTools: z
    .array(z.enum(AGENT_MODERATION_TOOLS))
    .max(AGENT_MODERATION_TOOLS.length)
    .default([])
    .transform((list) => [...new Set(list)]),
  /** What in the meeting it may look at: the whiteboard, polls, shared screens. */
  perception: z
    .array(z.enum(AGENT_PERCEPTION))
    .max(AGENT_PERCEPTION.length)
    .default([])
    .transform((list) => [...new Set(list)]),
  /** The admin's rules for when the agent acts on its own (e.g. who to let in). */
  moderationRules: z.string().trim().max(4000, 'Regras muito longas (máx. 4000 caracteres)').default(''),
  /** Saved provider credentials (Integrações): required, there is no server fallback. */
  llmIntegrationId: z.string({ error: 'Escolha a integração de LLM' }).uuid('Escolha a integração de LLM'),
  /** Speaking (TTS) and listening (STT) are chosen separately: any provider for each. */
  ttsIntegrationId: z.string({ error: 'Escolha a integração de voz' }).uuid('Escolha a integração de voz'),
  sttIntegrationId: z
    .string({ error: 'Escolha a integração de transcrição' })
    .uuid('Escolha a integração de transcrição'),
});

const integrationName = z.string().trim().min(1, 'Dê um nome para a integração').max(60);
const apiKey = z.string().trim().min(8, 'Chave muito curta').max(512).optional();
const modelId = z.string().trim().min(1).max(120);

export const integrationInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('llm'),
    name: integrationName,
    baseUrl: z.string().trim().min(1, 'Informe a URL da API').max(300),
    apiKey,
    defaultModel: modelId,
    models: z.array(modelId).max(200).default([]),
  }),
  z.object({
    kind: z.literal('fish'),
    name: integrationName,
    apiKey,
    defaultModel: z
      .string()
      .trim()
      .regex(/^[a-z0-9._-]{1,40}$/, 'Modelo de voz inválido')
      .default('s2.1-pro'),
  }),
  z.object({ kind: z.literal('deepgram'), name: integrationName, apiKey }),
  z.object({ kind: z.literal('elevenlabs'), name: integrationName, apiKey }),
]);

export const meetingInput = z.object({
  roomSlug,
  title: z.string().trim().min(1, 'Informe o título da reunião').max(120),
  description: z.string().trim().max(2000).default(''),
  startsAt: z.string().datetime({ offset: true, message: 'Data e hora inválidas' }),
  durationMin: z.number().int().min(5).max(1440).default(60),
  invitees: z
    .array(z.string().trim().toLowerCase().email('E-mail de convidado inválido'))
    .max(50, 'Até 50 convidados por reunião')
    .default([]),
});

export const lobbyDecisionInput = z.object({
  id: z.string().uuid(),
  approve: z.boolean(),
});

export const joinInput = z.object({
  displayName,
  password: z.string().max(128).optional(),
});

export const handInput = z.object({
  token: z.string().min(20).max(4096),
  raised: z.boolean(),
});

export const TOOL_KINDS = ['http', 'mcp'] as const;
export const TOOL_ACCESS = ['moderators', 'members'] as const;
export const TOOL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const TOOL_PARAM_TYPES = ['string', 'number', 'integer', 'boolean'] as const;
export const MAX_TOOLS_PER_AGENT = 20;
/** Headers the platform sets itself (or that would let a tool smuggle another request). */
export const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
  'keep-alive',
  'mcp-session-id',
  'mcp-protocol-version',
]);

const toolName = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Nome da ferramenta: letras minúsculas, números e _ (até 40)');

const toolParam = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/, 'Nome de parâmetro inválido'),
  type: z.enum(TOOL_PARAM_TYPES),
  description: z.string().trim().max(300).default(''),
  required: z.boolean().default(false),
});

const toolHeader = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/, 'Nome de cabeçalho inválido')
    .refine((n) => !RESERVED_HEADERS.has(n.toLowerCase()), 'Esse cabeçalho é definido pela plataforma'),
  /** Empty keeps the value already saved for this header. */
  value: z
    .string()
    .max(4000)
    .refine((v) => !/[\r\n]/.test(v), 'Valor de cabeçalho inválido'),
});

const toolCommon = {
  name: toolName,
  enabled: z.boolean().default(true),
  access: z.enum(TOOL_ACCESS).default('moderators'),
  confirm: z.boolean().default(true),
  url: z.string().trim().min(1, 'Informe a URL').max(2000, 'URL muito longa'),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  /** null keeps the saved headers; a list replaces them. */
  headers: z
    .array(toolHeader)
    .max(20)
    .nullable()
    .default(null)
    .refine(
      (hs) => !hs || new Set(hs.map((h) => h.name.toLowerCase())).size === hs.length,
      'Cabeçalho repetido',
    ),
};

export const agentToolInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    ...toolCommon,
    description: z
      .string()
      .trim()
      .min(1, 'Explique para a IA quando usar a ferramenta')
      .max(1000, 'Descrição muito longa (máx. 1000 caracteres)'),
    method: z.enum(TOOL_METHODS),
    params: z
      .array(toolParam)
      .max(20)
      .default([])
      .refine((ps) => new Set(ps.map((p) => p.name)).size === ps.length, 'Parâmetro repetido'),
    bodyTemplate: z.string().trim().max(8000).nullable().default(null),
  }),
  z.object({
    kind: z.literal('mcp'),
    ...toolCommon,
    description: z.string().trim().max(1000, 'Descrição muito longa (máx. 1000 caracteres)').default(''),
    /** The server's tools the agent may call; none until an admin picks them. */
    mcpTools: z
      .array(z.string().min(1).max(128))
      .max(100)
      .default([])
      .transform((ts) => [...new Set(ts)]),
  }),
]);

/** What the voice worker sends when the model calls an external tool. */
export const agentToolRunInput = z.object({
  room: z.string().min(3).max(200),
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Everyone who spoke in the turn being answered: all of them must be allowed. */
  requestedBy: z.array(z.string().min(1).max(200)).min(1).max(5),
});

export const agentToolTestInput = z.object({ args: z.record(z.string(), z.unknown()).default({}) });

/** First validation message, safe to show to the user. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Dados inválidos';
}

/** URL-safe slug from a free-text name: "Reunião de Vendas!" -> "reuniao-de-vendas". */
export function slugify(text: string, maxLength = 64): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}
