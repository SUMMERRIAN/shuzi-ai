import { query } from "./db.js";

export async function ensureSchema() {
  await query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel TEXT NOT NULL CHECK (channel IN ('username', 'email', 'phone')),
      identifier TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'unknown',
      display_name TEXT,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'parent', 'teacher', 'admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS students (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '未命名学生',
      grade TEXT,
      stage TEXT,
      profile_status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS student_memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID REFERENCES students(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL DEFAULT 'free',
      plan_name TEXT NOT NULL DEFAULT '免费用户',
      status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'pending', 'active', 'expired', 'cancelled')),
      started_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS learning_token_wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS learning_token_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('recharge', 'consume', 'refund', 'adjust')),
      source TEXT NOT NULL DEFAULT 'manual',
      note TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS storage_quotas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      base_mb INTEGER NOT NULL DEFAULT 50,
      expansion_mb INTEGER NOT NULL DEFAULT 0,
      used_bytes BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS storage_expansion_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL,
      storage_gb INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS payment_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_type TEXT NOT NULL CHECK (order_type IN ('membership', 'lt_recharge', 'storage_expansion')),
      package_id TEXT NOT NULL,
      title TEXT NOT NULL,
      amount_cny NUMERIC(10,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
      provider TEXT NOT NULL DEFAULT 'manual',
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS student_archive_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      title TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS student_intake_questionnaires (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answers JSONB NOT NULL DEFAULT '{}'::jsonb,
      completion INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS student_statements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT,
      scene TEXT,
      intensity INTEGER,
      content TEXT NOT NULL,
      guided_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS student_learning_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report JSONB NOT NULL DEFAULT '{}'::jsonb,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS uploaded_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      path TEXT NOT NULL,
      mime_type TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS learning_calendar_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_date DATE NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      file_ids UUID[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS library_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES library_items(id) ON DELETE SET NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('folder', 'file', 'document')),
      name TEXT NOT NULL,
      file_id UUID REFERENCES uploaded_files(id) ON DELETE SET NULL,
      content TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      mime_type TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      is_starred BOOLEAN NOT NULL DEFAULT false,
      is_trashed BOOLEAN NOT NULL DEFAULT false,
      last_opened_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS paper_uploads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT,
      exam_name TEXT,
      note TEXT,
      file_ids UUID[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS paper_analysis_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      paper_upload_id UUID REFERENCES paper_uploads(id) ON DELETE SET NULL,
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS mistake_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT,
      title TEXT,
      file_ids UUID[] NOT NULL DEFAULT '{}',
      analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS generated_practice (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_mistake_id UUID REFERENCES mistake_files(id) ON DELETE SET NULL,
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS knowledge_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      note JSONB NOT NULL DEFAULT '{}'::jsonb,
      image_base64 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS free_ask_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID REFERENCES students(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '新的对话',
      memory_summary TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      is_archived BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS free_ask_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES free_ask_conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL DEFAULT '',
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ai_generation_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID REFERENCES students(id) ON DELETE CASCADE,
      feature TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      input JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      error JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS forum_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID REFERENCES students(id) ON DELETE SET NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_type TEXT NOT NULL DEFAULT '学习问题',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      file_ids UUID[] NOT NULL DEFAULT '{}',
      likes INTEGER NOT NULL DEFAULT 0,
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      pinned_at TIMESTAMPTZ,
      pinned_by TEXT,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS forum_replies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id UUID NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS statement_audio_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_id UUID REFERENCES uploaded_files(id) ON DELETE SET NULL,
      transcript TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_students_user_id ON students(user_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON student_memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_archive_student_type ON student_archive_events(student_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_uploaded_files_user_id ON uploaded_files(user_id);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_user_date ON learning_calendar_events(user_id, event_date);
    CREATE INDEX IF NOT EXISTS idx_library_items_user_parent ON library_items(user_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_library_items_user_view ON library_items(user_id, is_trashed, is_starred, updated_at);
    CREATE INDEX IF NOT EXISTS idx_forum_posts_created_at ON forum_posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_forum_posts_activity ON forum_posts(is_pinned DESC, pinned_at DESC, last_activity_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_forum_replies_post_id ON forum_replies(post_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_user_feature ON ai_generation_jobs(user_id, feature, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_free_ask_conversations_user_last ON free_ask_conversations(user_id, is_archived, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_free_ask_messages_conversation_created ON free_ask_messages(conversation_id, created_at);
  `);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS provider TEXT`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS mode TEXT`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS external_response_id TEXT`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS token_cost INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS request_hash TEXT`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS usage JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS provider_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS provider_cost_cny NUMERIC(12,4) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS billable_cny NUMERIC(12,4) NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS billing_markup NUMERIC(8,3) NOT NULL DEFAULT 3.5`);
  await query(`ALTER TABLE ai_generation_jobs ADD COLUMN IF NOT EXISTS billed_tokens INTEGER NOT NULL DEFAULT 0`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_user_feature_hash
    ON ai_generation_jobs(user_id, feature, request_hash, created_at DESC)
    WHERE request_hash IS NOT NULL`);
  await query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_channel_check;
    ALTER TABLE users ADD CONSTRAINT users_channel_check CHECK (channel IN ('username', 'email', 'phone'));
  `);
  await query(`ALTER TABLE library_items ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false`);
  await query(`ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`);
  await query(`ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS pinned_by TEXT`);
  await query(`ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
  await query(`UPDATE forum_posts SET last_activity_at = COALESCE(updated_at, created_at, now()) WHERE last_activity_at IS NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_forum_posts_activity
    ON forum_posts(is_pinned DESC, pinned_at DESC, last_activity_at DESC, created_at DESC)`);
  await query(`ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
}
