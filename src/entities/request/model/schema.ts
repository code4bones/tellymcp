import * as z from "zod/v4";

export const askUserTelegramInputSchema = z.object({
  question: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
  context: z.string().trim().min(1).optional(),
  affected_files: z.array(z.string().trim().min(1)).optional(),
  options: z.array(z.string().trim().min(1)).optional(),
  recommended_option: z.string().trim().min(1).optional(),
  risk_level: z.enum(["low", "medium", "high"]).optional(),
  timeout_seconds: z.number().int().positive().optional(),
  fallback_if_timeout: z.string().trim().min(1).optional(),
  session_id: z.string().trim().min(1).optional(),
  use_saved_context: z.boolean().optional(),
});

export const askUserTelegramOutputSchema = z.object({
  request_id: z.string(),
  answer: z.string().nullable(),
  timed_out: z.boolean(),
  received_at: z.string().optional(),
  fallback_used: z.string().optional(),
});

export const notifyTelegramInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
  context: z.string().trim().min(1).optional(),
  risk_level: z.enum(["low", "medium", "high"]).optional(),
  use_saved_context: z.boolean().optional(),
});

export const notifyTelegramOutputSchema = z.object({
  sent: z.boolean(),
  message_id: z.number().int().positive().optional(),
});

export const getTelegramInboxInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const getTelegramInboxOutputSchema = z.object({
  session_id: z.string(),
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
  messages: z.array(
    z.object({
      message_id: z.string(),
      telegram_chat_id: z.number(),
      telegram_user_id: z.number(),
      text: z.string(),
      received_at: z.string(),
    }),
  ),
});

export const getTelegramInboxCountInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const getTelegramInboxCountOutputSchema = z.object({
  session_id: z.string(),
  total: z.number().int().nonnegative(),
});

export const deleteTelegramInboxMessageInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  message_id: z.string().trim().min(1),
});

export const deleteTelegramInboxMessageOutputSchema = z.object({
  deleted: z.boolean(),
  session_id: z.string(),
  message_id: z.string(),
});

export const createSessionPairCodeInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  session_label: z.string().trim().min(1).optional(),
  expires_in_seconds: z.number().int().positive().optional(),
});

export const createSessionPairCodeOutputSchema = z.object({
  session_id: z.string(),
  code: z.string(),
  expires_at: z.string(),
  status: z.literal("pending"),
  status_message: z.string(),
  telegram_link_hint: z.string().optional(),
});

export const setSessionContextInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  session_label: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).optional(),
  decisions: z.array(z.string().trim().min(1)).optional(),
  risks: z.array(z.string().trim().min(1)).optional(),
});

export const setSessionContextOutputSchema = z.object({
  saved: z.boolean(),
  session_id: z.string(),
  updated_at: z.string(),
  has_binding: z.boolean(),
});

export const getSessionContextInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const getSessionContextOutputSchema = z.object({
  session_id: z.string(),
  exists: z.boolean(),
  has_binding: z.boolean(),
  human_channel_mode: z.enum(["direct", "telegram"]),
  telegram_polling_enabled: z.boolean(),
  status_message: z.string(),
  context: z
    .object({
      session_label: z.string().optional(),
      task: z.string().optional(),
      summary: z.string().optional(),
      files: z.array(z.string()).optional(),
      decisions: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
      human_channel_mode: z.enum(["direct", "telegram"]).optional(),
      updated_at: z.string().optional(),
    })
    .optional(),
  binding: z
    .object({
      telegram_chat_id: z.number(),
      telegram_user_id: z.number(),
      linked_at: z.string(),
    })
    .optional(),
  tmux: z
    .object({
      configured: z.boolean(),
      tmux_session_name: z.string().optional(),
      tmux_target: z.string().optional(),
      last_nudge_at: z.string().optional(),
    })
    .optional(),
});

export const clearSessionContextInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const clearSessionContextOutputSchema = z.object({
  cleared: z.boolean(),
  session_id: z.string(),
  cleared_pairing: z.boolean(),
});

export const clearSessionPairingInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const clearSessionPairingOutputSchema = z.object({
  cleared: z.boolean(),
  session_id: z.string(),
});

export const setHumanChannelModeInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  mode: z.enum(["direct", "telegram"]),
});

export const setHumanChannelModeOutputSchema = z.object({
  session_id: z.string(),
  human_channel_mode: z.enum(["direct", "telegram"]),
  telegram_polling_enabled: z.boolean(),
  tmux_target_configured: z.boolean(),
  tmux_nudge_enabled: z.boolean(),
  status_message: z.string(),
  agent_instruction: z.string(),
});

export const getHumanChannelModeInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const getHumanChannelModeOutputSchema = z.object({
  session_id: z.string(),
  has_binding: z.boolean(),
  human_channel_mode: z.enum(["direct", "telegram"]),
  telegram_polling_enabled: z.boolean(),
  tmux_target_configured: z.boolean(),
  tmux_nudge_enabled: z.boolean(),
  status_message: z.string(),
  agent_instruction: z.string(),
});

export const setTmuxTargetInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
  tmux_session_name: z.string().trim().min(1).max(200).optional(),
  tmux_target: z.string().trim().min(1).max(200),
});

export const setTmuxTargetOutputSchema = z.object({
  session_id: z.string(),
  tmux_target: z.string(),
  tmux_session_name: z.string().optional(),
  status_message: z.string(),
});

export const getTmuxTargetInputSchema = z.object({
  session_id: z.string().trim().min(1).optional(),
});

export const getTmuxTargetOutputSchema = z.object({
  session_id: z.string(),
  configured: z.boolean(),
  tmux_target: z.string().optional(),
  tmux_session_name: z.string().optional(),
  last_nudge_at: z.string().optional(),
  status_message: z.string(),
});
