/**
 * geneWeave — OpenAPI 3.1.0 specification
 *
 * Returns a plain JS object describing the full API contract.
 * No runtime imports from routes; this is a pure data function.
 */

export function buildOpenApiSpec(): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'geneWeave API',
      version: '1.0.0',
      description:
        'geneWeave is the HTTP API layer of the weaveIntel AI-orchestration platform. ' +
        'It exposes chat, memory, agenda, notes, voice, compliance, and admin surfaces.',
    },
    servers: [{ url: '/', description: 'geneWeave API' }],
    security: [{ cookieAuth: [] }],
    tags: [
      { name: 'auth', description: 'Authentication, registration, OAuth, passkeys' },
      { name: 'chat', description: 'Chat threads and message streaming' },
      { name: 'dashboard', description: 'Usage metrics and cost analytics' },
      { name: 'me', description: 'User-scoped runs, tasks, reminders, devices, preferences' },
      { name: 'agenda', description: 'Calendar agenda items and categories' },
      { name: 'notes', description: 'Rich-text notes, links, and databases' },
      { name: 'memories', description: 'Long-term user memory (semantic, entity, user-authored)' },
      { name: 'conversations', description: 'Conversation list with pin/archive metadata' },
      { name: 'compliance', description: 'GDPR account deletion and data export' },
      { name: 'settings', description: 'User preferences, chat settings, and user memory' },
      { name: 'models', description: 'Available models and tools discovery' },
      { name: 'voice', description: 'Voice session lifecycle and audio turns' },
      { name: 'traces', description: 'Execution traces and agent activity' },
      { name: 'a2a', description: 'Agent-to-Agent task API (machine-to-machine)' },
      { name: 'health', description: 'Readiness and liveness probes' },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'auth_token',
          description: 'HttpOnly JWT cookie set by POST /api/auth/login',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Bearer JWT for native/mobile/A2A clients (from POST /api/auth/token)',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
            correlationId: { type: 'string', format: 'uuid' },
          },
        },
        User: {
          type: 'object',
          required: ['id', 'email', 'name', 'persona'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            name: { type: 'string' },
            persona: { type: 'string', enum: ['tenant_user', 'tenant_admin', 'platform_admin'] },
            tenantId: { type: 'string', nullable: true },
          },
        },
        Session: {
          type: 'object',
          required: ['user', 'csrfToken', 'permissions'],
          properties: {
            user: { $ref: '#/components/schemas/User' },
            csrfToken: { type: 'string' },
            permissions: { type: 'array', items: { type: 'string' } },
          },
        },
        LoginResponse: {
          allOf: [
            { $ref: '#/components/schemas/Session' },
            {
              type: 'object',
              properties: {
                token: { type: 'string', description: 'Bearer JWT (only in /api/auth/token response)' },
                expiresAt: { type: 'string', format: 'date-time' },
              },
            },
          ],
        },
        Chat: {
          type: 'object',
          required: ['id', 'userId', 'title', 'model', 'provider'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            model: { type: 'string' },
            provider: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Message: {
          type: 'object',
          required: ['id', 'role', 'content'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
            content: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        AgendaItem: {
          type: 'object',
          required: ['id', 'title', 'kind'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            kind: { type: 'string', enum: ['event', 'reminder', 'deadline', 'appointment', 'recurring', 'follow-up'] },
            status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'] },
            sensitivity: { type: 'string', enum: ['normal', 'confidential', 'restricted'] },
            startAt: { type: 'string', nullable: true },
            endAt: { type: 'string', nullable: true },
            allDay: { type: 'integer', enum: [0, 1] },
            location: { type: 'string', nullable: true },
            description: { type: 'string', nullable: true },
            categoryId: { type: 'string', nullable: true },
            recurrenceRule: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Note: {
          type: 'object',
          required: ['id', 'title'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            icon: { type: 'string', nullable: true },
            cover: { type: 'string', nullable: true },
            parentNoteId: { type: 'string', nullable: true },
            sensitivity: { type: 'string', enum: ['normal', 'confidential', 'restricted'] },
            docJson: { type: 'string', description: 'Tiptap-compatible JSON document' },
            favorite: { type: 'integer', enum: [0, 1] },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Memory: {
          type: 'object',
          required: ['id', 'content', 'kind', 'createdAt', 'provenance'],
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            kind: { type: 'string', enum: ['semantic', 'entity', 'user-authored'] },
            createdAt: { type: 'string', format: 'date-time' },
            provenance: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                confidence: { type: 'number' },
                extractedBy: { type: 'string' },
                verifiedBy: { type: 'string' },
              },
            },
          },
        },
        Conversation: {
          type: 'object',
          required: ['id', 'title'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            snippet: { type: 'string', nullable: true },
            mode: { type: 'string', nullable: true },
            updatedAt: { type: 'string', format: 'date-time' },
            runStatus: { type: 'string', nullable: true },
            pinned: { type: 'boolean' },
            archived: { type: 'boolean' },
            hasPendingAction: { type: 'boolean' },
            participants: { type: 'array', items: { type: 'string' } },
            unread: { type: 'boolean' },
          },
        },
        Run: {
          type: 'object',
          required: ['id', 'status'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
            surface: { type: 'string', nullable: true },
            metadata: { type: 'object', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Task: {
          type: 'object',
          required: ['id', 'title', 'assignee', 'status'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string', nullable: true },
            assignee: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'completed', 'cancelled', 'rejected', 'expired'] },
            priority: { type: 'string' },
            dueAt: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Reminder: {
          type: 'object',
          required: ['id', 'ownerPrincipalId'],
          properties: {
            id: { type: 'string' },
            ownerPrincipalId: { type: 'string' },
            label: { type: 'string' },
            enabled: { type: 'boolean' },
            source: { type: 'object' },
            target: { type: 'object' },
            metadata: { type: 'object' },
          },
        },
        VoiceSession: {
          type: 'object',
          required: ['sessionId', 'status'],
          properties: {
            sessionId: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            chatId: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['active', 'ended'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        VoiceConfig: {
          type: 'object',
          properties: {
            sttProvider: { type: 'string' },
            sttModel: { type: 'string' },
            sttLanguage: { type: 'string' },
            ttsProvider: { type: 'string' },
            ttsModel: { type: 'string' },
            ttsVoice: { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
            ttsSpeed: { type: 'number', minimum: 0.25, maximum: 4.0 },
            ttsFormat: { type: 'string', enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] },
            mode: { type: 'string', enum: ['agent', 'direct', 'supervisor'] },
            pipelineMode: { type: 'string', enum: ['chained', 'realtime'] },
          },
        },
        OAuthAccount: {
          type: 'object',
          required: ['id', 'provider'],
          properties: {
            id: { type: 'string' },
            provider: { type: 'string' },
            email: { type: 'string', nullable: true },
            name: { type: 'string', nullable: true },
            picture_url: { type: 'string', nullable: true },
            linked_at: { type: 'string', format: 'date-time' },
            last_used_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        PasskeyCredential: {
          type: 'object',
          required: ['id', 'credentialId'],
          properties: {
            id: { type: 'string' },
            credentialId: { type: 'string' },
            aaguid: { type: 'string', nullable: true },
            transports: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string', format: 'date-time' },
            lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        A2APart: {
          type: 'object',
          description: 'A2A v1.0 Part — field-presence polymorphism (no type discriminator)',
          properties: {
            text: { type: 'string' },
            raw: { type: 'string', description: 'base64-encoded bytes' },
            url: { type: 'string', description: 'Remote file reference' },
            data: { description: 'Structured JSON value' },
            mediaType: { type: 'string' },
            filename: { type: 'string' },
          },
        },
        A2AMessage: {
          type: 'object',
          required: ['role', 'parts'],
          properties: {
            role: { type: 'string', enum: ['user', 'agent'] },
            parts: { type: 'array', items: { $ref: '#/components/schemas/A2APart' } },
            messageId: { type: 'string' },
            contextId: { type: 'string' },
            taskId: { type: 'string' },
          },
        },
        A2ATaskSendParams: {
          type: 'object',
          required: ['message'],
          description: 'A2A v1.0 task submission params (what clients send)',
          properties: {
            message: { $ref: '#/components/schemas/A2AMessage' },
            configuration: {
              type: 'object',
              properties: {
                acceptedOutputModes: { type: 'array', items: { type: 'string' } },
                returnImmediately: { type: 'boolean' },
                historyLength: { type: 'integer' },
              },
            },
            metadata: { type: 'object', nullable: true },
          },
        },
        A2ATask: {
          type: 'object',
          required: ['id', 'contextId', 'status', 'artifacts', 'history'],
          description: 'A2A v1.0 Task object (what the server returns)',
          properties: {
            id: { type: 'string' },
            contextId: { type: 'string' },
            status: {
              type: 'object',
              required: ['state', 'timestamp'],
              properties: {
                state: {
                  type: 'string',
                  enum: [
                    'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED',
                    'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED',
                    'TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_REJECTED',
                  ],
                },
                message: { $ref: '#/components/schemas/A2AMessage', nullable: true },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
            artifacts: {
              type: 'array',
              items: {
                type: 'object',
                required: ['artifactId', 'name', 'parts'],
                properties: {
                  artifactId: { type: 'string' },
                  name: { type: 'string' },
                  parts: { type: 'array', items: { $ref: '#/components/schemas/A2APart' } },
                },
              },
            },
            history: { type: 'array', items: { $ref: '#/components/schemas/A2AMessage' } },
            metadata: { type: 'object', nullable: true },
          },
        },
        // Deprecated — kept for OpenAPI clients on old schema
        A2ATaskResult: {
          type: 'object',
          deprecated: true,
          description: 'Deprecated: use A2ATask (v1.0)',
          required: ['id', 'status'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['completed', 'failed'] },
            output: { type: 'object', nullable: true },
            error: { type: 'string', nullable: true },
          },
        },
        ChatSettings: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            mode: { type: 'string', enum: ['direct', 'agent', 'supervisor', 'ensemble'] },
            system_prompt: { type: 'string', nullable: true },
            timezone: { type: 'string', nullable: true },
            enabled_tools: { type: 'string', nullable: true },
            redaction_enabled: { type: 'integer', enum: [0, 1] },
            redaction_patterns: { type: 'string', nullable: true },
            workers: { type: 'string', nullable: true },
          },
        },
        UserPreferences: {
          type: 'object',
          properties: {
            default_mode: { type: 'string', enum: ['direct', 'agent', 'supervisor'] },
            theme: { type: 'string', enum: ['light', 'dark'] },
            show_process_card: { type: 'integer', enum: [0, 1] },
          },
        },
      },
    },
    paths: {
      // ── Health ──────────────────────────────────────────────────────────────
      '/healthz': {
        get: {
          operationId: 'getLiveness',
          summary: 'Liveness probe',
          tags: ['health'],
          security: [],
          responses: {
            200: { description: 'Server is alive', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } },
          },
        },
      },
      '/readyz': {
        get: {
          operationId: 'getReadiness',
          summary: 'Readiness probe — checks all subsystems',
          tags: ['health'],
          security: [],
          responses: {
            200: { description: 'All checks pass' },
            503: { description: 'One or more checks failed' },
          },
        },
      },
      '/api/openapi.json': {
        get: {
          operationId: 'getOpenApiSpec',
          summary: 'Machine-readable OpenAPI 3.1.0 specification',
          tags: ['health'],
          security: [],
          responses: {
            200: { description: 'OpenAPI spec object', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },

      // ── Auth ────────────────────────────────────────────────────────────────
      '/api/auth/register': {
        post: {
          operationId: 'register',
          summary: 'Register a new user account',
          tags: ['auth'],
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'email', 'password'],
                  properties: {
                    name: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 8 },
                    invitationToken: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Account created', content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' }, requiresEmailVerification: { type: 'boolean' }, message: { type: 'string' } } } } } },
            400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            409: { description: 'Email already registered', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            429: { description: 'Rate limited' },
          },
        },
      },
      '/api/auth/login': {
        post: {
          operationId: 'login',
          summary: 'Login with email and password (sets HttpOnly cookie)',
          tags: ['auth'],
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } },
            401: { description: 'Invalid credentials' },
            429: { description: 'Rate limited' },
          },
        },
      },
      '/api/auth/token': {
        post: {
          operationId: 'getToken',
          summary: 'Login and receive a Bearer JWT in the response body (for native/CLI clients)',
          tags: ['auth'],
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Bearer token issued', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            401: { description: 'Invalid credentials' },
          },
        },
      },
      '/api/auth/logout': {
        post: {
          operationId: 'logout',
          summary: 'Invalidate the current session and clear the auth cookie',
          tags: ['auth'],
          responses: {
            200: { description: 'Logged out', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
          },
        },
      },
      '/api/auth/me': {
        get: {
          operationId: 'getAuthMe',
          summary: 'Return the authenticated user and CSRF token',
          tags: ['auth'],
          responses: {
            200: { description: 'Current session', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/auth/check': {
        get: {
          operationId: 'authCheck',
          summary: 'Non-throwing auth check for UI bootstrap (always 200)',
          tags: ['auth'],
          security: [],
          responses: {
            200: { description: 'Auth state', content: { 'application/json': { schema: { type: 'object', properties: { authenticated: { type: 'boolean' }, user: { $ref: '#/components/schemas/User' }, csrfToken: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } } } } },
          },
        },
      },
      '/api/auth/permissions': {
        get: {
          operationId: 'getPermissions',
          summary: 'Return the caller\'s effective persona and permissions list',
          tags: ['auth'],
          responses: {
            200: { description: 'Permissions', content: { 'application/json': { schema: { type: 'object', properties: { persona: { type: 'string' }, effectivePersona: { type: 'string', nullable: true }, permissions: { type: 'array', items: { type: 'string' } } } } } } },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/auth/verify-email': {
        post: {
          operationId: 'verifyEmail',
          summary: 'Consume an email verification token',
          tags: ['auth'],
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } } },
          responses: {
            200: { description: 'Email verified' },
            400: { description: 'Invalid or expired token' },
          },
        },
      },
      '/api/auth/resend-verification': {
        post: {
          operationId: 'resendVerification',
          summary: 'Resend the email verification link',
          tags: ['auth'],
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } } },
          responses: {
            200: { description: 'Verification email sent (always 200 to prevent enumeration)' },
          },
        },
      },
      '/api/auth/passkey/register/begin': {
        post: {
          operationId: 'passkeyRegisterBegin',
          summary: 'Begin FIDO2/WebAuthn passkey registration (returns creation options)',
          tags: ['auth'],
          responses: {
            200: { description: 'WebAuthn creation options' },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/auth/passkey/register/complete': {
        post: {
          operationId: 'passkeyRegisterComplete',
          summary: 'Complete passkey registration (verify attestation)',
          tags: ['auth'],
          responses: {
            200: { description: 'Passkey registered' },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/auth/passkey/auth/begin': {
        post: {
          operationId: 'passkeyAuthBegin',
          summary: 'Begin passkey authentication (returns request options)',
          tags: ['auth'],
          security: [],
          responses: {
            200: { description: 'WebAuthn request options' },
          },
        },
      },
      '/api/auth/passkey/auth/complete': {
        post: {
          operationId: 'passkeyAuthComplete',
          summary: 'Complete passkey authentication (verify assertion, issue session)',
          tags: ['auth'],
          security: [],
          responses: {
            200: { description: 'Authenticated via passkey' },
          },
        },
      },
      '/api/auth/passkeys': {
        get: {
          operationId: 'listPasskeys',
          summary: 'List registered passkey credentials for the current user',
          tags: ['auth'],
          responses: {
            200: { description: 'Passkey list', content: { 'application/json': { schema: { type: 'object', properties: { credentials: { type: 'array', items: { $ref: '#/components/schemas/PasskeyCredential' } } } } } } },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/auth/passkeys/{credentialId}': {
        delete: {
          operationId: 'deletePasskey',
          summary: 'Delete a passkey credential',
          tags: ['auth'],
          parameters: [{ name: 'credentialId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Deleted' },
            404: { description: 'Not found' },
          },
        },
      },

      // ── OAuth ───────────────────────────────────────────────────────────────
      '/api/oauth/providers': {
        get: {
          operationId: 'listOAuthProviders',
          summary: 'List configured OAuth providers',
          tags: ['auth'],
          security: [],
          responses: {
            200: { description: 'Provider list', content: { 'application/json': { schema: { type: 'object', properties: { providers: { type: 'array', items: { type: 'string' } } } } } } },
          },
        },
      },
      '/api/oauth/accounts': {
        get: {
          operationId: 'listOAuthAccounts',
          summary: 'List OAuth accounts linked to the authenticated user',
          tags: ['auth'],
          responses: {
            200: { description: 'Linked accounts', content: { 'application/json': { schema: { type: 'object', properties: { accounts: { type: 'array', items: { $ref: '#/components/schemas/OAuthAccount' } } } } } } },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/oauth/accounts/{provider}/unlink': {
        post: {
          operationId: 'unlinkOAuthAccount',
          summary: 'Unlink an OAuth provider account',
          tags: ['auth'],
          parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Unlinked' },
            400: { description: 'Invalid provider' },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/oauth/authorize-url': {
        post: {
          operationId: 'getOAuthAuthorizeUrl',
          summary: 'Generate an OAuth authorization URL',
          tags: ['auth'],
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['provider'], properties: { provider: { type: 'string' }, redirectUri: { type: 'string', description: 'App scheme for native mobile flow' } } } } } },
          responses: {
            200: { description: 'Authorization URL', content: { 'application/json': { schema: { type: 'object', properties: { authUrl: { type: 'string', format: 'uri' } } } } } },
            400: { description: 'Invalid provider' },
          },
        },
      },
      '/api/oauth/callback': {
        get: {
          operationId: 'oauthCallbackGet',
          summary: 'OAuth callback handler (GET — redirect from provider)',
          tags: ['auth'],
          security: [],
          parameters: [
            { name: 'code', in: 'query', schema: { type: 'string' } },
            { name: 'state', in: 'query', schema: { type: 'string' } },
            { name: 'error', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'OAuth popup close page (HTML)' },
            400: { description: 'OAuth error' },
          },
        },
        post: {
          operationId: 'oauthCallbackPost',
          summary: 'OAuth callback handler (POST — form body)',
          tags: ['auth'],
          security: [],
          requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { code: { type: 'string' }, state: { type: 'string' } } } } } },
          responses: {
            200: { description: 'Account linked' },
            400: { description: 'OAuth error' },
          },
        },
      },

      // ── Chat ────────────────────────────────────────────────────────────────
      '/api/chats': {
        get: {
          operationId: 'listChats',
          summary: 'List the authenticated user\'s chat threads',
          tags: ['chat'],
          responses: {
            200: { description: 'Chat list', content: { 'application/json': { schema: { type: 'object', properties: { chats: { type: 'array', items: { $ref: '#/components/schemas/Chat' } } } } } } },
            401: { description: 'Not authenticated' },
          },
        },
        post: {
          operationId: 'createChat',
          summary: 'Create a new chat thread',
          tags: ['chat'],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', default: 'New Chat' },
                    model: { type: 'string' },
                    provider: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Chat created', content: { 'application/json': { schema: { type: 'object', properties: { chat: { $ref: '#/components/schemas/Chat' } } } } } },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/chats/{chatId}': {
        put: {
          operationId: 'updateChat',
          summary: 'Rename a chat thread',
          tags: ['chat'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 200 } } } } } },
          responses: {
            200: { description: 'Updated chat', content: { 'application/json': { schema: { type: 'object', properties: { chat: { $ref: '#/components/schemas/Chat' } } } } } },
            404: { description: 'Chat not found' },
          },
        },
        delete: {
          operationId: 'deleteChat',
          summary: 'Delete a chat thread and all its messages',
          tags: ['chat'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Deleted' },
            404: { description: 'Chat not found' },
          },
        },
      },
      '/api/chats/{chatId}/messages': {
        get: {
          operationId: 'getChatMessages',
          summary: 'Get all messages in a chat',
          tags: ['chat'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Messages', content: { 'application/json': { schema: { type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } } } } },
            404: { description: 'Chat not found' },
          },
        },
        post: {
          operationId: 'sendMessage',
          summary: 'Send a message (JSON response or SSE stream when stream:true)',
          tags: ['chat'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    content: { type: 'string' },
                    stream: { type: 'boolean', default: false },
                    model: { type: 'string' },
                    provider: { type: 'string' },
                    maxTokens: { type: 'integer' },
                    temperature: { type: 'number' },
                    attachments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, mimeType: { type: 'string' }, size: { type: 'integer' } } } },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Message response (JSON) or SSE stream', content: { 'application/json': { schema: { type: 'object' } }, 'text/event-stream': { schema: { type: 'string' } } } },
            400: { description: 'Validation error' },
            404: { description: 'Chat not found' },
          },
        },
      },
      '/api/chats/{chatId}/messages/stream': {
        post: {
          operationId: 'streamMessage',
          summary: 'Send a message and always receive an SSE stream',
          tags: ['chat'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' }, maxTokens: { type: 'integer' }, temperature: { type: 'number' } } } } } },
          responses: {
            200: { description: 'SSE event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          },
        },
      },
      '/api/messages/{id}/feedback': {
        post: {
          operationId: 'submitMessageFeedback',
          summary: 'Submit a feedback signal on an assistant message',
          tags: ['chat'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['signal', 'modelId', 'provider', 'taskKey'],
                  properties: {
                    signal: { type: 'string', enum: ['thumbs_up', 'thumbs_down', 'regenerate', 'copy'] },
                    comment: { type: 'string', nullable: true },
                    modelId: { type: 'string' },
                    provider: { type: 'string' },
                    taskKey: { type: 'string' },
                    chatId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Feedback recorded' },
            400: { description: 'Validation error' },
          },
        },
      },

      // ── Dashboard ───────────────────────────────────────────────────────────
      '/api/dashboard/overview': {
        get: {
          operationId: 'getDashboardOverview',
          summary: 'Get total chats, messages, token usage, and cost summary',
          tags: ['dashboard'],
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: { 200: { description: 'Overview metrics' }, 401: { description: 'Not authenticated' } },
        },
      },
      '/api/dashboard/costs': {
        get: {
          operationId: 'getDashboardCosts',
          summary: 'Per-model cost breakdown over time',
          tags: ['dashboard'],
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: { 200: { description: 'Cost breakdown' }, 401: { description: 'Not authenticated' } },
        },
      },
      '/api/dashboard/performance': {
        get: {
          operationId: 'getDashboardPerformance',
          summary: 'Latency percentiles and throughput metrics',
          tags: ['dashboard'],
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: { 200: { description: 'Performance metrics' }, 401: { description: 'Not authenticated' } },
        },
      },
      '/api/dashboard/evals': {
        get: {
          operationId: 'getDashboardEvals',
          summary: 'Eval assertion results (pass/fail/score)',
          tags: ['dashboard'],
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: { 200: { description: 'Eval results' }, 401: { description: 'Not authenticated' } },
        },
      },
      '/api/dashboard/traces': {
        get: {
          operationId: 'getDashboardTraces',
          summary: 'User execution traces (dashboard view)',
          tags: ['traces'],
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }],
          responses: { 200: { description: 'Traces list' }, 401: { description: 'Not authenticated' } },
        },
      },
      '/api/dashboard/agent-activity': {
        get: {
          operationId: 'getAgentActivity',
          summary: 'Agent activity log with model, cost, and latency',
          tags: ['traces'],
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }],
          responses: { 200: { description: 'Activity rows' }, 401: { description: 'Not authenticated' } },
        },
      },

      // ── Traces ──────────────────────────────────────────────────────────────
      '/api/chats/{chatId}/traces': {
        get: {
          operationId: 'getChatTraces',
          summary: 'Get execution traces for a chat (plural form, legacy)',
          tags: ['traces'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Trace list' }, 404: { description: 'Chat not found' } },
        },
      },
      '/api/chats/{chatId}/trace': {
        get: {
          operationId: 'getChatTrace',
          summary: 'Get strategy-enriched trace events for a chat',
          tags: ['traces'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Events array' }, 404: { description: 'Chat not found' } },
        },
      },

      // ── Settings ────────────────────────────────────────────────────────────
      '/api/chats/{chatId}/settings': {
        get: {
          operationId: 'getChatSettings',
          summary: 'Get per-chat settings (mode, system prompt, tools…)',
          tags: ['settings'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Chat settings', content: { 'application/json': { schema: { type: 'object', properties: { settings: { $ref: '#/components/schemas/ChatSettings' } } } } } },
            404: { description: 'Chat not found' },
          },
        },
        post: {
          operationId: 'saveChatSettings',
          summary: 'Save per-chat settings',
          tags: ['settings'],
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatSettings' } } } },
          responses: {
            200: { description: 'Saved' },
            404: { description: 'Chat not found' },
          },
        },
      },
      '/api/user/preferences': {
        get: {
          operationId: 'getUserPreferences',
          summary: 'Get the authenticated user\'s preferences',
          tags: ['settings'],
          responses: {
            200: { description: 'Preferences', content: { 'application/json': { schema: { type: 'object', properties: { preferences: { $ref: '#/components/schemas/UserPreferences' } } } } } },
          },
        },
        post: {
          operationId: 'saveUserPreferences',
          summary: 'Save user preferences (default_mode, theme, show_process_card)',
          tags: ['settings'],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UserPreferences' } } } },
          responses: { 200: { description: 'Saved' } },
        },
      },
      '/api/user/memory': {
        get: {
          operationId: 'getUserMemory',
          summary: 'Get all memory types for the authenticated user (entities, semantic, episodic, procedural, working)',
          tags: ['settings'],
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
          responses: { 200: { description: 'All memory types' } },
        },
      },
      '/api/user/memory/semantic/{id}': {
        delete: {
          operationId: 'deleteSemanticMemory',
          summary: 'Delete a single semantic memory entry',
          tags: ['settings'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/api/user/memory/entity/{entityName}': {
        delete: {
          operationId: 'deleteEntity',
          summary: 'Forget an entity by name',
          tags: ['settings'],
          parameters: [{ name: 'entityName', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/api/user/memory/episodic/{id}': {
        delete: {
          operationId: 'deleteEpisodicMemory',
          summary: 'Remove an episodic memory event',
          tags: ['settings'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/api/user/memory/working/{id}': {
        delete: {
          operationId: 'deleteWorkingMemory',
          summary: 'Delete a working memory snapshot',
          tags: ['settings'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/api/user/memory/all': {
        delete: {
          operationId: 'clearAllMemory',
          summary: 'Full memory wipe (all types)',
          tags: ['settings'],
          responses: { 200: { description: 'Cleared' } },
        },
      },

      // ── Models ──────────────────────────────────────────────────────────────
      '/api/models': {
        get: {
          operationId: 'listModels',
          summary: 'List available AI models and the current default',
          tags: ['models'],
          responses: {
            200: { description: 'Models', content: { 'application/json': { schema: { type: 'object', properties: { models: { type: 'array', items: { type: 'object' } }, defaultModel: { type: 'string' } } } } } },
          },
        },
      },
      '/api/tools': {
        get: {
          operationId: 'listTools',
          summary: 'List tools available to the caller\'s persona',
          tags: ['models'],
          responses: {
            200: { description: 'Tools list', content: { 'application/json': { schema: { type: 'object', properties: { tools: { type: 'array', items: { type: 'object' } }, persona: { type: 'string' } } } } } },
          },
        },
      },

      // ── Me — Runs ───────────────────────────────────────────────────────────
      '/api/me/runs': {
        get: {
          operationId: 'listRuns',
          summary: 'List the caller\'s runs',
          tags: ['me'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200, default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { 200: { description: 'Run list', content: { 'application/json': { schema: { type: 'object', properties: { runs: { type: 'array', items: { $ref: '#/components/schemas/Run' } } } } } } } },
        },
        post: {
          operationId: 'createRun',
          summary: 'Create and dispatch a new run',
          tags: ['me'],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    surface: { type: 'string' },
                    input: { type: 'object' },
                    metadata: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Run created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Run' } } } } },
        },
      },
      '/api/me/runs/{runId}': {
        get: {
          operationId: 'getRun',
          summary: 'Get a run by ID',
          tags: ['me'],
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Run', content: { 'application/json': { schema: { $ref: '#/components/schemas/Run' } } } }, 404: { description: 'Not found' } },
        },
      },
      '/api/me/runs/{runId}/events': {
        get: {
          operationId: 'getRunEvents',
          summary: 'SSE event stream for a run (resumable via ?after=<seq>)',
          tags: ['me'],
          parameters: [
            { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'after', in: 'query', schema: { type: 'integer', default: -1 } },
          ],
          responses: { 200: { description: 'SSE event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
        },
        post: {
          operationId: 'appendRunEvent',
          summary: 'Append a client-originated event to a run',
          tags: ['me'],
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { kind: { type: 'string' }, payload: { type: 'object' } } } } } },
          responses: { 201: { description: 'Event appended', content: { 'application/json': { schema: { type: 'object', properties: { sequence: { type: 'integer' } } } } } } },
        },
      },
      '/api/me/runs/{runId}/cancel': {
        post: {
          operationId: 'cancelRun',
          summary: 'Cancel a running run',
          tags: ['me'],
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Cancelled' }, 409: { description: 'Run already in terminal state' } },
        },
      },

      // ── Me — Catalog / Theme ────────────────────────────────────────────────
      '/api/me/catalog': {
        get: {
          operationId: 'getMeCatalog',
          summary: 'Resolve the surface catalog for the caller',
          tags: ['me'],
          parameters: [{ name: 'surface', in: 'query', schema: { type: 'string', default: 'web' } }],
          responses: { 200: { description: 'Catalog and starter prompts' } },
        },
      },
      '/api/me/theme': {
        get: {
          operationId: 'getMeTheme',
          summary: 'Get per-tenant design tokens',
          tags: ['me'],
          responses: { 200: { description: 'Theme tokens (null when not configured)' } },
        },
      },

      // ── Me — Tasks ──────────────────────────────────────────────────────────
      '/api/me/tasks': {
        get: {
          operationId: 'listTasks',
          summary: 'List action-item tasks assigned to the caller',
          tags: ['me'],
          responses: { 200: { description: 'Task list', content: { 'application/json': { schema: { type: 'object', properties: { tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } } } } } } } },
        },
        post: {
          operationId: 'createTask',
          summary: 'Create an action-item task',
          tags: ['me'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title'],
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    dueAt: { type: 'string', format: 'date-time' },
                    actionable: { type: 'boolean' },
                    provenance: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Task created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } } } },
        },
      },
      '/api/me/tasks/{taskId}/complete': {
        post: {
          operationId: 'completeTask',
          summary: 'Mark a task as completed',
          tags: ['me'],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Completed task' }, 404: { description: 'Not found' } },
        },
      },
      '/api/me/tasks/{taskId}/cancel': {
        post: {
          operationId: 'cancelTask',
          summary: 'Cancel a task',
          tags: ['me'],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Cancelled task' }, 404: { description: 'Not found' } },
        },
      },
      '/api/me/notifications/actions': {
        post: {
          operationId: 'handleNotificationAction',
          summary: 'Approve or deny a task notification action',
          tags: ['me'],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['taskId', 'actionId'], properties: { taskId: { type: 'string' }, actionId: { type: 'string', enum: ['approve', 'deny'] } } } } } },
          responses: { 200: { description: 'Action processed' }, 404: { description: 'Not found' } },
        },
      },

      // ── Me — Reminders ──────────────────────────────────────────────────────
      '/api/me/reminders': {
        get: {
          operationId: 'listReminders',
          summary: 'List reminders (trigger-store + agent-created temporal)',
          tags: ['me'],
          responses: { 200: { description: 'Reminders', content: { 'application/json': { schema: { type: 'object', properties: { reminders: { type: 'array', items: { $ref: '#/components/schemas/Reminder' } } } } } } } },
        },
        post: {
          operationId: 'createReminder',
          summary: 'Create a reminder trigger',
          tags: ['me'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', default: 'Reminder' },
                    fireAt: { type: 'string', format: 'date-time' },
                    rrule: { type: 'string', description: 'iCal RRULE string for recurring reminders' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Reminder created' } },
        },
      },
      '/api/me/reminders/{reminderId}': {
        delete: {
          operationId: 'deleteReminder',
          summary: 'Delete a reminder',
          tags: ['me'],
          parameters: [{ name: 'reminderId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } },
        },
      },
      '/api/me/reminders/{reminderId}/reschedule': {
        post: {
          operationId: 'rescheduleReminder',
          summary: 'Reschedule a one-shot reminder',
          tags: ['me'],
          parameters: [{ name: 'reminderId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fireAt'], properties: { fireAt: { type: 'string', format: 'date-time' } } } } } },
          responses: { 200: { description: 'Rescheduled' }, 404: { description: 'Not found' } },
        },
      },

      // ── Me — Devices ────────────────────────────────────────────────────────
      '/api/me/devices': {
        post: {
          operationId: 'registerDevice',
          summary: 'Register a push notification device token',
          tags: ['me'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['channel', 'token'],
                  properties: {
                    channel: { type: 'string', enum: ['web-push', 'apns', 'fcm'] },
                    token: { type: 'string' },
                    label: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Registered' }, 400: { description: 'Invalid channel or missing token' } },
        },
      },
      '/api/me/devices/{token}': {
        delete: {
          operationId: 'unregisterDevice',
          summary: 'Unregister a push notification device',
          tags: ['me'],
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Removed' } },
        },
      },

      // ── Me — Notification preferences ──────────────────────────────────────
      '/api/me/notification-preferences': {
        get: {
          operationId: 'getNotificationPrefs',
          summary: 'Get notification preferences',
          tags: ['me'],
          responses: { 200: { description: 'Preferences' } },
        },
        put: {
          operationId: 'saveNotificationPrefs',
          summary: 'Update notification preferences',
          tags: ['me'],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { enabled: { type: 'boolean' }, categories: { type: 'array', items: { type: 'string' } }, quietHours: { type: 'string', nullable: true } } } } } },
          responses: { 200: { description: 'Saved' } },
        },
      },

      // ── WS ticket ───────────────────────────────────────────────────────────
      '/api/ws-ticket': {
        post: {
          operationId: 'issueWsTicket',
          summary: 'Issue a short-lived opaque WebSocket upgrade ticket (60s TTL)',
          tags: ['voice'],
          responses: {
            200: { description: 'Ticket', content: { 'application/json': { schema: { type: 'object', properties: { ticket: { type: 'string' }, expiresInMs: { type: 'integer' } } } } } },
            401: { description: 'Not authenticated' },
          },
        },
      },

      // ── Agenda — categories ─────────────────────────────────────────────────
      '/api/me/agenda/categories': {
        get: {
          operationId: 'listAgendaCategories',
          summary: 'List agenda categories (system defaults + user-owned)',
          tags: ['agenda'],
          responses: { 200: { description: 'Categories' } },
        },
        post: {
          operationId: 'createAgendaCategory',
          summary: 'Create a user agenda category',
          tags: ['agenda'],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, color: { type: 'string' }, icon: { type: 'string' } } } } } },
          responses: { 201: { description: 'Category created' } },
        },
      },
      '/api/me/agenda/categories/{id}': {
        patch: {
          operationId: 'updateAgendaCategory',
          summary: 'Update an agenda category',
          tags: ['agenda'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, icon: { type: 'string' } } } } } },
          responses: { 200: { description: 'Updated' } },
        },
        delete: {
          operationId: 'deleteAgendaCategory',
          summary: 'Delete a user-owned agenda category',
          tags: ['agenda'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },

      // ── Agenda — items ──────────────────────────────────────────────────────
      '/api/me/agenda': {
        get: {
          operationId: 'listAgendaItems',
          summary: 'List agenda items with optional filters',
          tags: ['agenda'],
          parameters: [
            { name: 'start', in: 'query', schema: { type: 'string' } },
            { name: 'end', in: 'query', schema: { type: 'string' } },
            { name: 'kind', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 50 } },
          ],
          responses: { 200: { description: 'Agenda items', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/AgendaItem' } } } } } } } },
        },
        post: {
          operationId: 'createAgendaItem',
          summary: 'Create an agenda item (supports nlText quick-add)',
          tags: ['agenda'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    nlText: { type: 'string', description: 'Natural-language text for quick-add parsing' },
                    kind: { type: 'string', enum: ['event', 'reminder', 'deadline', 'appointment', 'recurring', 'follow-up'] },
                    start_at: { type: 'string' },
                    end_at: { type: 'string' },
                    all_day: { type: 'integer', enum: [0, 1] },
                    location: { type: 'string' },
                    description: { type: 'string' },
                    category_id: { type: 'string' },
                    recurrence_rule: { type: 'string' },
                    status: { type: 'string' },
                    sensitivity: { type: 'string' },
                    amount: { type: 'string' },
                    currency: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Item created', content: { 'application/json': { schema: { $ref: '#/components/schemas/AgendaItem' } } } } },
        },
      },
      '/api/me/agenda/{id}': {
        get: {
          operationId: 'getAgendaItem',
          summary: 'Get a single agenda item',
          tags: ['agenda'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Agenda item', content: { 'application/json': { schema: { $ref: '#/components/schemas/AgendaItem' } } } }, 404: { description: 'Not found' } },
        },
        patch: {
          operationId: 'updateAgendaItem',
          summary: 'Update an agenda item',
          tags: ['agenda'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AgendaItem' } } } },
          responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } },
        },
        delete: {
          operationId: 'deleteAgendaItem',
          summary: 'Delete an agenda item',
          tags: ['agenda'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } },
        },
      },

      // ── Notes ───────────────────────────────────────────────────────────────
      '/api/me/notes': {
        get: {
          operationId: 'listNotes',
          summary: 'List notes with optional filters',
          tags: ['notes'],
          parameters: [
            { name: 'parent', in: 'query', schema: { type: 'string', description: 'Parent note id or "null" for root' } },
            { name: 'favorite', in: 'query', schema: { type: 'integer', enum: [0, 1] } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 50 } },
          ],
          responses: { 200: { description: 'Notes', content: { 'application/json': { schema: { type: 'object', properties: { notes: { type: 'array', items: { $ref: '#/components/schemas/Note' } } } } } } } },
        },
        post: {
          operationId: 'createNote',
          summary: 'Create a note (optionally from a template)',
          tags: ['notes'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    icon: { type: 'string' },
                    cover: { type: 'string' },
                    parent_note_id: { type: 'string' },
                    sensitivity: { type: 'string', enum: ['normal', 'confidential', 'restricted'] },
                    doc_json: { type: 'string' },
                    template_id: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Note created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } } },
        },
      },
      '/api/me/notes/templates': {
        get: {
          operationId: 'listNoteTemplates',
          summary: 'List system and user note templates',
          tags: ['notes'],
          responses: { 200: { description: 'Templates' } },
        },
      },
      '/api/me/notes/{id}': {
        get: {
          operationId: 'getNote',
          summary: 'Get a note with full doc_json',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Note', content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } }, 404: { description: 'Not found' } },
        },
        patch: {
          operationId: 'updateNote',
          summary: 'Update a note',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } },
          responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } },
        },
        delete: {
          operationId: 'deleteNote',
          summary: 'Delete a note (cascades sub-pages)',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } },
        },
      },
      '/api/me/notes/{id}/links': {
        get: {
          operationId: 'listNoteLinks',
          summary: 'List outbound links from a note',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Links' } },
        },
        post: {
          operationId: 'createNoteLink',
          summary: 'Create a link from a note to another entity',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['target_kind', 'target_id'], properties: { target_kind: { type: 'string', enum: ['note', 'run', 'agenda_item', 'task'] }, target_id: { type: 'string' } } } } } },
          responses: { 201: { description: 'Link created' } },
        },
      },
      '/api/me/notes/{id}/links/{linkId}': {
        delete: {
          operationId: 'deleteNoteLink',
          summary: 'Delete a note link',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'linkId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/api/me/notes/{id}/backlinks': {
        get: {
          operationId: 'listNoteBacklinks',
          summary: 'List notes that link to this note',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Backlinks' } },
        },
      },
      '/api/me/notes/{id}/extract': {
        post: {
          operationId: 'extractNoteContent',
          summary: 'Save-time extraction: create tasks from to-do checkboxes',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Extracted tasks', content: { 'application/json': { schema: { type: 'object', properties: { extractedTasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } } } } } } } },
        },
      },

      // ── Note databases ──────────────────────────────────────────────────────
      '/api/me/note-databases': {
        get: {
          operationId: 'listNoteDatabases',
          summary: 'List saved note database views',
          tags: ['notes'],
          responses: { 200: { description: 'Databases' } },
        },
        post: {
          operationId: 'createNoteDatabase',
          summary: 'Create a note database (saved view)',
          tags: ['notes'],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, source: { type: 'string', enum: ['agenda_items', 'tasks', 'generic'] }, view_type: { type: 'string', enum: ['table', 'board', 'calendar'] } } } } } },
          responses: { 201: { description: 'Database created' } },
        },
      },
      '/api/me/note-databases/{id}': {
        delete: {
          operationId: 'deleteNoteDatabase',
          summary: 'Delete a note database',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/api/me/note-databases/{id}/rows': {
        get: {
          operationId: 'listNoteDatabaseRows',
          summary: 'List rows in a note database',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Rows' } },
        },
        post: {
          operationId: 'createNoteDatabaseRow',
          summary: 'Add a row to a note database',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { fields: { type: 'object' } } } } } },
          responses: { 201: { description: 'Row created' } },
        },
      },
      '/api/me/note-databases/{id}/rows/{rowId}': {
        patch: {
          operationId: 'updateNoteDatabaseRow',
          summary: 'Update a note database row',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { fields: { type: 'object' } } } } } },
          responses: { 200: { description: 'Updated' } },
        },
        delete: {
          operationId: 'deleteNoteDatabaseRow',
          summary: 'Delete a note database row',
          tags: ['notes'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },

      // ── Memories ────────────────────────────────────────────────────────────
      '/api/me/memories': {
        get: {
          operationId: 'listMemories',
          summary: 'List memories grouped by kind (semantic, entity, user-authored)',
          tags: ['memories'],
          responses: {
            200: {
              description: 'Memories grouped by kind',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      memories: { type: 'object', properties: { semantic: { type: 'array', items: { $ref: '#/components/schemas/Memory' } }, entity: { type: 'array', items: { $ref: '#/components/schemas/Memory' } }, 'user-authored': { type: 'array', items: { $ref: '#/components/schemas/Memory' } } } },
                      counts: { type: 'object', properties: { semantic: { type: 'integer' }, entity: { type: 'integer' }, 'user-authored': { type: 'integer' } } },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createMemory',
          summary: 'Create a user-authored memory entry',
          tags: ['memories'],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['content'], properties: { content: { type: 'string', minLength: 1, maxLength: 2000 }, kind: { type: 'string', default: 'user_fact' } } } } } },
          responses: { 201: { description: 'Memory created' }, 400: { description: 'Content out of bounds' }, 403: { description: 'Memory is org-managed (read-only)' } },
        },
        delete: {
          operationId: 'clearAllMemories',
          summary: 'Clear ALL user memories (requires confirm:true)',
          tags: ['memories'],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'boolean', enum: [true] } } } } } },
          responses: { 200: { description: 'Cleared' }, 400: { description: 'confirm:true required' }, 403: { description: 'Org-managed memory' } },
        },
      },
      '/api/me/memories/{id}': {
        patch: {
          operationId: 'correctMemory',
          summary: 'Correct a memory entry (preserves lineage)',
          tags: ['memories'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['content'], properties: { content: { type: 'string', minLength: 1, maxLength: 2000 }, reason: { type: 'string' } } } } } },
          responses: { 200: { description: 'Corrected entry' }, 403: { description: 'Org-managed memory' }, 404: { description: 'Not found' } },
        },
        delete: {
          operationId: 'deleteMemory',
          summary: 'Delete a single memory entry',
          tags: ['memories'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' }, 403: { description: 'Org-managed memory' }, 404: { description: 'Not found' } },
        },
      },

      // ── Conversations ───────────────────────────────────────────────────────
      '/api/me/conversations': {
        get: {
          operationId: 'listConversations',
          summary: 'List conversations with search and filter support',
          tags: ['conversations'],
          parameters: [
            { name: 'query', in: 'query', schema: { type: 'string' } },
            { name: 'filter', in: 'query', schema: { type: 'string', enum: ['active', 'archived', 'pinned', 'all'], default: 'active' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200, default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { 200: { description: 'Conversations', content: { 'application/json': { schema: { type: 'object', properties: { conversations: { type: 'array', items: { $ref: '#/components/schemas/Conversation' } } } } } } } },
        },
      },
      '/api/me/conversations/{id}': {
        patch: {
          operationId: 'updateConversation',
          summary: 'Pin, archive, or rename a conversation',
          tags: ['conversations'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { pinned: { type: 'boolean' }, archived: { type: 'boolean' }, title: { type: 'string', maxLength: 200 } } } } } },
          responses: { 200: { description: 'Updated conversation', content: { 'application/json': { schema: { type: 'object', properties: { conversation: { $ref: '#/components/schemas/Conversation' } } } } } }, 404: { description: 'Not found' } },
        },
      },
      '/api/me/conversations/{id}/messages': {
        get: {
          operationId: 'getConversationMessages',
          summary: 'Get message transcript for a conversation',
          tags: ['conversations'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000, default: 500 } },
          ],
          responses: { 200: { description: 'Messages', content: { 'application/json': { schema: { type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } } } } }, 404: { description: 'Not found' } },
        },
      },

      // ── Compliance ──────────────────────────────────────────────────────────
      '/api/me/account': {
        delete: {
          operationId: 'deleteAccount',
          summary: 'GDPR Art. 17 — delete the authenticated user account and all data',
          tags: ['compliance'],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'boolean', enum: [true] }, reason: { type: 'string', maxLength: 500 } } } } } },
          responses: {
            202: { description: 'Account deletion initiated', content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' }, requestId: { type: 'string' } } } } } },
            400: { description: 'confirm:true required' },
            401: { description: 'Not authenticated' },
          },
        },
      },
      '/api/me/export': {
        get: {
          operationId: 'exportUserData',
          summary: 'GDPR Art. 20 — download a portable JSON archive of all user data',
          tags: ['compliance'],
          responses: {
            200: {
              description: 'JSON archive (application/json with Content-Disposition: attachment)',
              content: { 'application/json': { schema: { type: 'object', properties: { exportedAt: { type: 'string', format: 'date-time' }, exportId: { type: 'string' }, subject: { type: 'string' }, profile: { $ref: '#/components/schemas/User' }, conversations: { type: 'array', items: { type: 'object' } }, notes: { type: 'array', items: { type: 'object' } }, agendaItems: { type: 'array', items: { type: 'object' } } } } } },
            },
            404: { description: 'User not found' },
          },
        },
      },

      // ── Voice ───────────────────────────────────────────────────────────────
      '/api/voice/config': {
        get: {
          operationId: 'getVoiceConfig',
          summary: 'Get the caller\'s voice configuration',
          tags: ['voice'],
          responses: { 200: { description: 'Voice config', content: { 'application/json': { schema: { type: 'object', properties: { config: { $ref: '#/components/schemas/VoiceConfig' } } } } } } },
        },
        post: {
          operationId: 'saveVoiceConfig',
          summary: 'Upsert voice preferences',
          tags: ['voice'],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/VoiceConfig' } } } },
          responses: { 200: { description: 'Saved config' } },
        },
      },
      '/api/voice/sessions': {
        get: {
          operationId: 'listVoiceSessions',
          summary: 'List the caller\'s voice sessions',
          tags: ['voice'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'ended'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 20 } },
          ],
          responses: { 200: { description: 'Sessions', content: { 'application/json': { schema: { type: 'object', properties: { sessions: { type: 'array', items: { $ref: '#/components/schemas/VoiceSession' } } } } } } } },
        },
        post: {
          operationId: 'createVoiceSession',
          summary: 'Create a new voice session',
          tags: ['voice'],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { chatId: { type: 'string' }, configOverride: { type: 'object' } } } } } },
          responses: { 201: { description: 'Session created', content: { 'application/json': { schema: { type: 'object', properties: { sessionId: { type: 'string' }, chatId: { type: 'string', nullable: true }, config: { $ref: '#/components/schemas/VoiceConfig' } } } } } } },
        },
      },
      '/api/voice/sessions/{sessionId}': {
        get: {
          operationId: 'getVoiceSession',
          summary: 'Get a voice session by ID',
          tags: ['voice'],
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Session', content: { 'application/json': { schema: { type: 'object', properties: { session: { $ref: '#/components/schemas/VoiceSession' } } } } } }, 404: { description: 'Not found' } },
        },
        delete: {
          operationId: 'endVoiceSession',
          summary: 'End a voice session',
          tags: ['voice'],
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Ended' }, 404: { description: 'Not found' } },
        },
      },
      '/api/voice/sessions/{sessionId}/turn': {
        post: {
          operationId: 'voiceTurn',
          summary: 'Submit an audio turn (STT → LLM → TTS). Accepts raw audio, multipart, or JSON with base64 audio.',
          tags: ['voice'],
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'audio/*': { schema: { type: 'string', format: 'binary' } },
              'multipart/form-data': { schema: { type: 'object', properties: { audio: { type: 'string', format: 'binary' } } } },
              'application/json': { schema: { type: 'object', properties: { audio: { type: 'string', description: 'Base64-encoded audio' }, mimeType: { type: 'string' }, text: { type: 'string', description: 'Text override (skips STT)' } } } },
            },
          },
          responses: {
            200: {
              description: 'Turn result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      sessionId: { type: 'string' },
                      turnIndex: { type: 'integer' },
                      transcript: { type: 'string' },
                      responseText: { type: 'string' },
                      responseAudio: { type: 'string', description: 'Base64-encoded audio' },
                      responseAudioMimeType: { type: 'string' },
                      sttMs: { type: 'integer' },
                      llmMs: { type: 'integer' },
                      ttsMs: { type: 'integer' },
                      costUsd: { type: 'number' },
                    },
                  },
                },
              },
            },
            409: { description: 'Session has ended' },
          },
        },
      },
      '/api/voice/sessions/{sessionId}/events': {
        get: {
          operationId: 'getVoiceSessionEvents',
          summary: 'Get the audit event log for a voice session',
          tags: ['voice'],
          parameters: [
            { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 100 } },
          ],
          responses: { 200: { description: 'Events list' }, 404: { description: 'Not found' } },
        },
      },

      // ── A2A (v1.0) ──────────────────────────────────────────────────────────
      '/.well-known/agent-card.json': {
        get: {
          operationId: 'getAgentCard',
          summary: 'A2A v1.0 Agent Card discovery',
          tags: ['a2a'],
          security: [],
          responses: { 200: { description: 'A2A v1.0 AgentCard', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/.well-known/agent.json': {
        get: {
          operationId: 'getAgentCardLegacy',
          summary: 'A2A Agent Card discovery (v0.3 legacy path)',
          tags: ['a2a'],
          security: [],
          responses: { 200: { description: 'AgentCard (same as agent-card.json)', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/a2a/tasks': {
        post: {
          operationId: 'submitA2ATask',
          summary: 'Submit an A2A task (v1.0 A2ATaskSendParams; synchronous)',
          description: 'Accepts A2ATaskSendParams (message.parts). Returns A2ATask with v1.0 state (TASK_STATE_COMPLETED / TASK_STATE_FAILED).',
          tags: ['a2a'],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/A2ATaskSendParams' } } },
          },
          responses: {
            200: { description: 'A2A Task (v1.0)', content: { 'application/json': { schema: { $ref: '#/components/schemas/A2ATask' } } } },
            400: { description: 'Invalid params' },
            401: { description: 'Bearer token required' },
          },
        },
      },
      '/api/a2a/tasks/{taskId}': {
        get: {
          operationId: 'getA2ATask',
          summary: 'Poll A2A task status',
          description: 'Returns the A2ATask. For synchronous tasks the result was delivered in the POST response; this returns TASK_STATE_COMPLETED.',
          tags: ['a2a'],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'historyLength', in: 'query', required: false, schema: { type: 'integer' } },
          ],
          responses: {
            200: { description: 'A2A Task (v1.0)', content: { 'application/json': { schema: { $ref: '#/components/schemas/A2ATask' } } } },
            401: { description: 'Bearer token required' },
          },
        },
      },

      // ── MCP Gateway ─────────────────────────────────────────────────────────
      '/api/mcp/gateway': {
        post: {
          operationId: 'mcpGatewayPost',
          summary: 'MCP gateway pass-through (bearer-authenticated, managed by MCP SDK)',
          tags: ['models'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'MCP response' }, 503: { description: 'Gateway not configured' } },
        },
        get: {
          operationId: 'mcpGatewayGet',
          summary: 'MCP gateway SSE endpoint',
          tags: ['models'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'MCP SSE stream' }, 503: { description: 'Gateway not configured' } },
        },
        delete: {
          operationId: 'mcpGatewayDelete',
          summary: 'MCP gateway session teardown',
          tags: ['models'],
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Session closed' }, 503: { description: 'Gateway not configured' } },
        },
      },
    },
  };
}
