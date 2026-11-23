import 'server-only';
import { ORG_PERMISSIONS } from '../rbac/permissions';

const bearer = {
  type: 'http' as const,
  scheme: 'bearer',
  bearerFormat: 'impa_',
  description:
    'Chave pessoal criada em Minha conta → Chaves de API. Prefixo `impa_`. Vale em todas as orgs do e-mail.',
};

const orgHeader = {
  name: 'X-Impa-Org',
  in: 'header' as const,
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description: 'UUID da organização (tenant). Liste com GET /api/v1/me.',
};

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
};

const roomSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    studio: { type: 'boolean' },
    allowGuests: { type: 'boolean' },
  },
};

/** OpenAPI 3.1 for ImpaMeet public REST — consumed by Scalar / agents. */
export function buildOpenApi(baseUrl?: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'IMPA Meet API',
      version: '1.0.0',
      summary: 'Salas, reuniões, agentes e bases de conhecimento',
      description: [
        'API pública do IMPA Meet.',
        '',
        '**Auth:** `Authorization: Bearer impa_…`',
        '**Org:** `X-Impa-Org: <tenant-uuid>` nas rotas de tenant',
        '',
        'A chave segue a pessoa (e-mail). Escopos vazios = todos os poderes do papel; senão `papel ∩ escopos`.',
        '',
        'MCP Streamable HTTP em `/api/mcp` (mesmas chaves). Índice para IAs: `/llms.txt`.',
      ].join('\n'),
      contact: { name: 'IMPA Meet' },
    },
    servers: [{ url: baseUrl || '/', description: 'Esta instalação' }],
    tags: [
      { name: 'Conta', description: 'Quem é a chave e em quais orgs ela age' },
      { name: 'Salas', description: 'Rooms e studios' },
      { name: 'Reuniões', description: 'Agendamento' },
      { name: 'Agentes', description: 'Assistentes de IA (requer agents.manage para escrever)' },
      { name: 'Conhecimento', description: 'Bases (requer knowledge.manage para criar)' },
    ],
    components: {
      securitySchemes: { BearerAuth: bearer },
      parameters: { OrgId: orgHeader },
      schemas: {
        Error: errorSchema,
        Room: roomSchema,
        OrgMembership: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            slug: { type: 'string' },
            role: { type: 'string' },
            isSuperadmin: { type: 'boolean' },
          },
        },
        CreateRoom: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 80 },
            slug: { type: 'string' },
            studio: { type: 'boolean', default: false },
            allowGuests: { type: 'boolean', default: true },
          },
        },
        CreateMeeting: {
          type: 'object',
          required: ['roomSlug', 'title', 'startsAt'],
          properties: {
            roomSlug: { type: 'string' },
            title: { type: 'string', maxLength: 120 },
            description: { type: 'string', maxLength: 2000 },
            startsAt: { type: 'string', format: 'date-time' },
            durationMin: { type: 'integer', minimum: 5, maximum: 1440, default: 60 },
            invitees: {
              type: 'array',
              items: { type: 'string', format: 'email' },
              maxItems: 50,
            },
          },
        },
        CreateAgent: {
          type: 'object',
          required: ['name', 'instructions', 'voices', 'ttsModel'],
          properties: {
            name: { type: 'string', maxLength: 60 },
            description: { type: 'string', maxLength: 160 },
            instructions: { type: 'string', maxLength: 20000 },
            greeting: { type: 'string', maxLength: 500 },
            voices: { type: 'object', additionalProperties: true },
            ttsModel: { type: 'string' },
          },
        },
        CreateKnowledgeBase: {
          type: 'object',
          required: ['name', 'embeddingIntegrationId'],
          properties: {
            name: { type: 'string', maxLength: 80 },
            description: { type: 'string', maxLength: 500 },
            embeddingIntegrationId: { type: 'string', format: 'uuid' },
            embeddingModel: { type: 'string' },
          },
        },
        OrgPermission: {
          type: 'string',
          enum: [...ORG_PERMISSIONS],
        },
      },
      responses: {
        Unauthorized: {
          description: 'Chave ausente, inválida ou revogada',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        Forbidden: {
          description: 'Sem membership na org ou sem permissão',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
    security: [{ BearerAuth: [] }],
    paths: {
      '/api/v1/me': {
        get: {
          tags: ['Conta'],
          summary: 'Quem sou eu',
          description: 'E-mail da chave, escopos e organizações ativas. Sem X-Impa-Org.',
          operationId: 'getMe',
          parameters: [],
          responses: {
            '200': {
              description: 'Identidade e memberships',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: { type: 'string', format: 'email' },
                      keyId: { type: 'string', format: 'uuid' },
                      scopes: { type: 'array', items: { $ref: '#/components/schemas/OrgPermission' } },
                      orgs: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/OrgMembership' },
                      },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/v1/me/orgs': {
        get: {
          tags: ['Conta'],
          summary: 'Listar organizações',
          operationId: 'listOrgs',
          responses: {
            '200': {
              description: 'Memberships',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      orgs: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/OrgMembership' },
                      },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/v1/rooms': {
        get: {
          tags: ['Salas'],
          summary: 'Listar salas',
          operationId: 'listRooms',
          parameters: [{ $ref: '#/components/parameters/OrgId' }],
          responses: {
            '200': {
              description: 'Salas visíveis',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      rooms: { type: 'array', items: { $ref: '#/components/schemas/Room' } },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
        post: {
          tags: ['Salas'],
          summary: 'Criar sala',
          operationId: 'createRoom',
          parameters: [{ $ref: '#/components/parameters/OrgId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateRoom' } },
            },
          },
          responses: {
            '201': {
              description: 'Sala criada',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { room: { $ref: '#/components/schemas/Room' } },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },
      '/api/v1/rooms/{slug}': {
        parameters: [
          { $ref: '#/components/parameters/OrgId' },
          {
            name: 'slug',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        get: {
          tags: ['Salas'],
          summary: 'Obter sala',
          operationId: 'getRoom',
          responses: {
            '200': {
              description: 'Sala',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { room: { $ref: '#/components/schemas/Room' } },
                  },
                },
              },
            },
            '404': {
              description: 'Não encontrada',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
        patch: {
          tags: ['Salas'],
          summary: 'Atualizar sala',
          operationId: 'updateRoom',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          responses: {
            '200': {
              description: 'Atualizada',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { room: { $ref: '#/components/schemas/Room' } },
                  },
                },
              },
            },
          },
        },
        delete: {
          tags: ['Salas'],
          summary: 'Excluir sala',
          operationId: 'deleteRoom',
          responses: {
            '200': {
              description: 'Excluída',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/meetings': {
        get: {
          tags: ['Reuniões'],
          summary: 'Listar reuniões',
          operationId: 'listMeetings',
          parameters: [{ $ref: '#/components/parameters/OrgId' }],
          responses: {
            '200': {
              description: 'Reuniões',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { meetings: { type: 'array', items: { type: 'object' } } },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Reuniões'],
          summary: 'Agendar reunião',
          operationId: 'scheduleMeeting',
          parameters: [{ $ref: '#/components/parameters/OrgId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateMeeting' } },
            },
          },
          responses: {
            '201': {
              description: 'Agendada',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { meeting: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/agents': {
        get: {
          tags: ['Agentes'],
          summary: 'Listar agentes',
          operationId: 'listAgents',
          parameters: [{ $ref: '#/components/parameters/OrgId' }],
          responses: {
            '200': {
              description: 'Agentes',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { agents: { type: 'array', items: { type: 'object' } } },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Agentes'],
          summary: 'Criar agente',
          description: 'Requer permissão `agents.manage`.',
          operationId: 'createAgent',
          parameters: [{ $ref: '#/components/parameters/OrgId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateAgent' } },
            },
          },
          responses: {
            '201': {
              description: 'Criado',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { agent: { type: 'object' } },
                  },
                },
              },
            },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },
      '/api/v1/agents/{id}': {
        parameters: [
          { $ref: '#/components/parameters/OrgId' },
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        patch: {
          tags: ['Agentes'],
          summary: 'Atualizar agente',
          operationId: 'updateAgent',
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateAgent' } },
            },
          },
          responses: {
            '200': {
              description: 'Atualizado',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { agent: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
        delete: {
          tags: ['Agentes'],
          summary: 'Excluir agente',
          operationId: 'deleteAgent',
          responses: {
            '200': {
              description: 'Excluído',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/knowledge-bases': {
        get: {
          tags: ['Conhecimento'],
          summary: 'Listar bases',
          operationId: 'listKnowledgeBases',
          parameters: [{ $ref: '#/components/parameters/OrgId' }],
          responses: {
            '200': {
              description: 'Bases',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      enabled: { type: 'boolean' },
                      bases: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Conhecimento'],
          summary: 'Criar base',
          description: 'Requer `knowledge.manage` e storage configurado.',
          operationId: 'createKnowledgeBase',
          parameters: [{ $ref: '#/components/parameters/OrgId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateKnowledgeBase' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Criada',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { base: { type: 'object' } },
                  },
                },
              },
            },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },
      '/api/mcp': {
        get: {
          tags: ['Conta'],
          summary: 'Descoberta MCP',
          security: [],
          operationId: 'mcpDiscovery',
          responses: {
            '200': {
              description: 'Metadados do transporte MCP',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
        post: {
          tags: ['Conta'],
          summary: 'MCP JSON-RPC',
          description: 'Streamable HTTP. Métodos: initialize, tools/list, tools/call. Tools espelham a REST.',
          operationId: 'mcpRpc',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jsonrpc: { type: 'string', enum: ['2.0'] },
                    id: {},
                    method: { type: 'string' },
                    params: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Resposta JSON-RPC',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
}
