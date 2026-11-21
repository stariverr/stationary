CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE TYPE "access_role" AS ENUM('VIEWER', 'EDITOR', 'ADMIN');--> statement-breakpoint
CREATE TYPE "ai_model_category" AS ENUM('generation', 'embedding', 'rerank');--> statement-breakpoint
CREATE TYPE "asset_origin" AS ENUM('FILE', 'EMBEDDED');--> statement-breakpoint
CREATE TYPE "av_stream_type" AS ENUM('VIDEO', 'AUDIO', 'SUBTITLE');--> statement-breakpoint
CREATE TYPE "delete_status" AS ENUM('ACTIVE', 'DELETED', 'PURGED');--> statement-breakpoint
CREATE TYPE "draft_file_status" AS ENUM('PENDING', 'DRAFT', 'CONSUMED', 'DELETED');--> statement-breakpoint
CREATE TYPE "embedding_role" AS ENUM('AI_CAPTION', 'IMAGE_PRIMARY');--> statement-breakpoint
CREATE TYPE "entity_type" AS ENUM('POST', 'MEDIA');--> statement-breakpoint
CREATE TYPE "library_embedding_space_status" AS ENUM('ACTIVE', 'BUILDING', 'RETIRED');--> statement-breakpoint
CREATE TYPE "lyrics_timing" AS ENUM('NONE', 'LINE', 'WORD');--> statement-breakpoint
CREATE TYPE "media_type" AS ENUM('IMAGE', 'VIDEO', 'LIVE_PHOTO', 'AUDIO', 'PDF');--> statement-breakpoint
CREATE TYPE "modality_type" AS ENUM('TEXT', 'IMAGE');--> statement-breakpoint
CREATE TYPE "original_kind" AS ENUM('IMAGE', 'PDF', 'VIDEO', 'AUDIO');--> statement-breakpoint
CREATE TYPE "post_source" AS ENUM('UNKNOWN', 'X', 'XHS', 'BILIBILI', 'DOUYIN', 'TIKTOK', 'INSTAGRAM');--> statement-breakpoint
CREATE TYPE "preview_size" AS ENUM('SMALL', 'MEDIUM', 'LARGE');--> statement-breakpoint
CREATE TYPE "source_error_kind" AS ENUM('NETWORK', 'SOURCE_UNAVAILABLE', 'UNREADABLE', 'INTERNAL', 'KIND_MISMATCH');--> statement-breakpoint
CREATE TYPE "sync_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "tag_source" AS ENUM('SCRAPER', 'AI', 'USER', 'IMPORT');--> statement-breakpoint
CREATE TYPE "tag_status" AS ENUM('ACTIVE', 'CANDIDATE', 'IGNORED');--> statement-breakpoint
CREATE TABLE "ai_model" (
	"id" uuid PRIMARY KEY,
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"category" "ai_model_category" NOT NULL,
	"capabilities" jsonb DEFAULT '{}' NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "ai_provider" (
	"id" uuid PRIMARY KEY,
	"owner_id" uuid NOT NULL,
	"template_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_ciphertext" text,
	"max_concurrency" integer DEFAULT 4 NOT NULL,
	"requests_per_minute" integer,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "asset_ai_metadata" (
	"id" uuid PRIMARY KEY,
	"library_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"objects" jsonb DEFAULT '[]' NOT NULL,
	"colors" jsonb DEFAULT '[]' NOT NULL,
	"styles" jsonb DEFAULT '[]' NOT NULL,
	"scene" text DEFAULT '' NOT NULL,
	"ocr_text" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"language" text NOT NULL,
	"input_hash" text,
	"is_stale" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"error_kind" text,
	"error_input_hash" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "asset_embedding" (
	"id" uuid PRIMARY KEY,
	"library_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"embedding_space_id" text NOT NULL,
	"embedding_role" "embedding_role" NOT NULL,
	"input_modality" "modality_type" NOT NULL,
	"dimension" integer,
	"embedding" halfvec,
	"content_hash" text,
	"source_file_id" uuid,
	"last_error" text,
	"error_kind" text,
	"error_input_hash" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz,
	CONSTRAINT "asset_emb_dimension_check" CHECK (vector_dims("embedding") = "dimension")
);
--> statement-breakpoint
CREATE TABLE "asset_search_document" (
	"id" uuid PRIMARY KEY,
	"library_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"source" text NOT NULL,
	"media_type" text,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"folded_title" text GENERATED ALWAYS AS (replace(lower(normalize("title", NFKC)), 'ß', 'ss')) STORED,
	"folded_content" text GENERATED ALWAYS AS (replace(lower(normalize("content", NFKC)), 'ß', 'ss')) STORED,
	"content_hash" text NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "author" (
	"id" uuid PRIMARY KEY,
	"library_id" uuid NOT NULL,
	"eid" text DEFAULT '' NOT NULL,
	"short_eid" text DEFAULT '' NOT NULL,
	"nickname" text DEFAULT '' NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"platform" "post_source" NOT NULL,
	"avatar_file_id" uuid,
	"avatar_thumb_file_id" uuid,
	"avatar_source_url" text,
	"avatar_source_file_id" uuid,
	"avatar_origin" text,
	"avatar_error" text,
	"avatar_error_origin" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz,
	"delete_time" timestamptz,
	"delete_status" "delete_status" DEFAULT 'ACTIVE'::"delete_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "av_file" (
	"id" uuid PRIMARY KEY,
	"file_id" uuid NOT NULL,
	"container" text NOT NULL,
	"duration" real,
	"bitrate" integer,
	"fragmented" boolean NOT NULL,
	"init_size" integer,
	"index_offset" bigint,
	"index_size" integer,
	"timescale" integer,
	"earliest_presentation_time" bigint,
	CONSTRAINT "av_file_segment_all_or_none" CHECK (("init_size" IS NULL) = ("index_offset" IS NULL)
                AND ("init_size" IS NULL) = ("index_size" IS NULL)
                AND ("init_size" IS NULL) = ("timescale" IS NULL)
                AND ("init_size" IS NULL) = ("earliest_presentation_time" IS NULL)),
	CONSTRAINT "av_file_segment_index_fragmented" CHECK ("init_size" IS NULL OR "fragmented")
);
--> statement-breakpoint
CREATE TABLE "av_stream" (
	"id" uuid PRIMARY KEY,
	"av_file_id" uuid NOT NULL,
	"stream_index" integer NOT NULL,
	"type" "av_stream_type" NOT NULL,
	"codec" text NOT NULL,
	"codec_string" text,
	"bitrate" integer,
	"language" text,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"width" integer,
	"height" integer,
	"rotation" smallint,
	"frame_rate" real,
	"channels" smallint,
	"sample_rate" integer,
	CONSTRAINT "av_stream_video_size" CHECK (("type" = 'VIDEO') = ("width" IS NOT NULL AND "height" IS NOT NULL)),
	CONSTRAINT "av_stream_video_only_fields" CHECK ("type" = 'VIDEO' OR ("rotation" IS NULL AND "frame_rate" IS NULL)),
	CONSTRAINT "av_stream_rotation_values" CHECK ("rotation" IS NULL OR "rotation" IN (0, 90, 180, 270)),
	CONSTRAINT "av_stream_audio_channels" CHECK (("type" = 'AUDIO') = ("channels" IS NOT NULL)),
	CONSTRAINT "av_stream_audio_only_fields" CHECK ("type" = 'AUDIO' OR "sample_rate" IS NULL),
	CONSTRAINT "av_stream_subtitle_no_codec_string" CHECK ("type" <> 'SUBTITLE' OR "codec_string" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "better_account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "better_session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "better_user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"external_id" text
);
--> statement-breakpoint
CREATE TABLE "better_verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "draft_file" (
	"id" uuid PRIMARY KEY,
	"file_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"status" "draft_file_status" DEFAULT 'DRAFT'::"draft_file_status" NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz DEFAULT now() NOT NULL,
	"expire_time" timestamptz,
	"consume_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "external_api_token" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"prefix" text DEFAULT 'st' NOT NULL,
	"first_four" text DEFAULT '' NOT NULL,
	"last_four" text DEFAULT '' NOT NULL,
	"owner_id" uuid NOT NULL,
	"library_id" uuid,
	"last_use_time" timestamptz,
	"expire_time" timestamptz,
	"revoke_time" timestamptz,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "file" (
	"id" uuid PRIMARY KEY,
	"hash" text,
	"size" bigint,
	"mime_type" text NOT NULL,
	"extension" text,
	"path" text NOT NULL UNIQUE,
	"bucket" text NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"delete_status" "delete_status" DEFAULT 'ACTIVE'::"delete_status" NOT NULL,
	"delete_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"pipeline" text,
	"subject_id" text,
	"library_id" uuid NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"enqueued_at" timestamptz DEFAULT now() NOT NULL,
	"available_at" timestamptz DEFAULT now() NOT NULL,
	"dirty" boolean DEFAULT false NOT NULL,
	"cursor" text,
	"lease_token" uuid,
	"lease_expires_at" timestamptz,
	"attempts" integer DEFAULT 0 NOT NULL,
	"interruptions" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "job_queue_pkey" PRIMARY KEY("pipeline","subject_id")
);
--> statement-breakpoint
CREATE TABLE "library" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"cover_file_id" uuid,
	"owner_id" uuid NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"ai_language" text DEFAULT 'en-US' NOT NULL,
	"ai_bindings" jsonb,
	"jobs_paused" boolean DEFAULT false NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz,
	"delete_time" timestamptz,
	"delete_status" "delete_status" DEFAULT 'ACTIVE'::"delete_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_embedding_space" (
	"id" uuid PRIMARY KEY,
	"library_id" uuid NOT NULL,
	"role" text NOT NULL,
	"model_id" uuid NOT NULL,
	"space_id" text NOT NULL,
	"status" "library_embedding_space_status" NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "library_group_access" (
	"id" uuid PRIMARY KEY,
	"library_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"role" "access_role" DEFAULT 'VIEWER'::"access_role" NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "library_user_access" (
	"id" uuid PRIMARY KEY,
	"library_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "access_role" DEFAULT 'VIEWER'::"access_role" NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY,
	"sort_order" integer NOT NULL,
	"eid" text NOT NULL,
	"post_id" uuid,
	"library_id" uuid NOT NULL,
	"source" "post_source" DEFAULT 'UNKNOWN'::"post_source" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"type" "media_type" NOT NULL,
	"display_width" integer,
	"display_height" integer,
	"duration" real,
	"published_time" timestamptz,
	"sync_status" "sync_status" DEFAULT 'PENDING'::"sync_status" NOT NULL,
	"excluded_source_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"user_edited_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"workflow_run_id" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz,
	"delete_status" "delete_status" DEFAULT 'ACTIVE'::"delete_status" NOT NULL,
	"delete_time" timestamptz,
	"recycle_time" timestamptz,
	CONSTRAINT "media_user_edited_fields" CHECK ("user_edited_fields" <@ ARRAY['type', 'title', 'description', 'published_time']::text[]),
	CONSTRAINT "media_display_size_pair" CHECK (("display_width" IS NULL) = ("display_height" IS NULL)),
	CONSTRAINT "media_display_size_by_type" CHECK ("type" NOT IN ('AUDIO', 'PDF') OR "display_width" IS NULL),
	CONSTRAINT "media_duration_by_type" CHECK ("type" NOT IN ('IMAGE', 'PDF') OR "duration" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "media_caption" (
	"id" uuid PRIMARY KEY,
	"media_id" uuid NOT NULL,
	"origin" "asset_origin" NOT NULL,
	"language" text,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"vtt_file_id" uuid,
	"source_file_id" uuid,
	"source_stream_id" uuid,
	"source_url" text,
	"source_key" text,
	"status" "sync_status" NOT NULL,
	"last_error" text,
	"error_kind" "source_error_kind",
	"error_source_url" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "media_caption_embedded_stream" CHECK (("origin" = 'EMBEDDED') = ("source_stream_id" IS NOT NULL)),
	CONSTRAINT "media_caption_file_source_only" CHECK ("origin" = 'FILE' OR "source_file_id" IS NULL),
	CONSTRAINT "media_caption_vtt_when_completed" CHECK (("status" = 'COMPLETED') = ("vtt_file_id" IS NOT NULL)),
	CONSTRAINT "media_caption_file_source_when_completed" CHECK ("origin" = 'EMBEDDED' OR "status" <> 'COMPLETED' OR "source_file_id" IS NOT NULL),
	CONSTRAINT "media_caption_source_pair" CHECK (("source_url" IS NULL) = ("source_key" IS NULL)),
	CONSTRAINT "media_caption_error_kind_pair" CHECK (("last_error" IS NULL) = ("error_kind" IS NULL)),
	CONSTRAINT "media_caption_error_on_current_source" CHECK ("error_source_url" IS NOT DISTINCT FROM (CASE WHEN "last_error" IS NULL THEN NULL ELSE "source_url" END)),
	CONSTRAINT "media_caption_error_when_failed" CHECK ("status" <> 'FAILED' OR "last_error" IS NOT NULL),
	CONSTRAINT "media_caption_no_error_when_completed" CHECK ("status" <> 'COMPLETED' OR "last_error" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "media_cover" (
	"id" uuid PRIMARY KEY,
	"media_id" uuid NOT NULL,
	"file_id" uuid,
	"source_url" text,
	"source_key" text,
	"status" "sync_status" NOT NULL,
	"last_error" text,
	"error_kind" "source_error_kind",
	"error_source_url" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "media_cover_error_kind_pair" CHECK (("last_error" IS NULL) = ("error_kind" IS NULL)),
	CONSTRAINT "media_cover_error_on_current_source" CHECK ("error_source_url" IS NOT DISTINCT FROM (CASE WHEN "last_error" IS NULL THEN NULL ELSE "source_url" END)),
	CONSTRAINT "media_cover_error_when_failed" CHECK ("status" <> 'FAILED' OR "last_error" IS NOT NULL),
	CONSTRAINT "media_cover_no_error_when_completed" CHECK ("status" <> 'COMPLETED' OR "last_error" IS NULL),
	CONSTRAINT "media_cover_file_when_completed" CHECK (("status" = 'COMPLETED') = ("file_id" IS NOT NULL)),
	CONSTRAINT "media_cover_source_or_file" CHECK ("source_url" IS NOT NULL OR "file_id" IS NOT NULL),
	CONSTRAINT "media_cover_source_pair" CHECK (("source_url" IS NULL) = ("source_key" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "media_lyrics" (
	"id" uuid PRIMARY KEY,
	"media_id" uuid NOT NULL,
	"origin" "asset_origin" NOT NULL,
	"language" text,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"timing" "lyrics_timing" NOT NULL,
	"lrc_file_id" uuid,
	"source_file_id" uuid,
	"original_id" uuid,
	"source_url" text,
	"source_key" text,
	"status" "sync_status" NOT NULL,
	"last_error" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "media_lyrics_embedded_original" CHECK (("origin" = 'EMBEDDED') = ("original_id" IS NOT NULL)),
	CONSTRAINT "media_lyrics_file_source_only" CHECK ("origin" = 'FILE' OR "source_file_id" IS NULL),
	CONSTRAINT "media_lyrics_lrc_when_completed" CHECK (("status" = 'COMPLETED') = ("lrc_file_id" IS NOT NULL)),
	CONSTRAINT "media_lyrics_file_source_when_completed" CHECK ("origin" = 'EMBEDDED' OR "status" <> 'COMPLETED' OR "source_file_id" IS NOT NULL),
	CONSTRAINT "media_lyrics_source_pair" CHECK (("source_url" IS NULL) = ("source_key" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "media_original" (
	"id" uuid PRIMARY KEY,
	"media_id" uuid NOT NULL,
	"file_id" uuid,
	"source_url" text,
	"source_key" text,
	"declared_language" text,
	"declared_label" text,
	"declared_default" boolean,
	"declared_kind" "original_kind",
	"status" "sync_status" NOT NULL,
	"last_error" text,
	"error_kind" "source_error_kind",
	"error_source_url" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "media_original_file_when_completed" CHECK (("status" = 'COMPLETED') = ("file_id" IS NOT NULL)),
	CONSTRAINT "media_original_source_pair" CHECK (("source_url" IS NULL) = ("source_key" IS NULL)),
	CONSTRAINT "media_original_declared_kind" CHECK (("source_key" IS NULL) = ("declared_kind" IS NULL)),
	CONSTRAINT "media_original_source_or_file" CHECK ("source_url" IS NOT NULL OR "file_id" IS NOT NULL),
	CONSTRAINT "media_original_error_kind_pair" CHECK (("last_error" IS NULL) = ("error_kind" IS NULL)),
	CONSTRAINT "media_original_error_on_current_source" CHECK ("error_source_url" IS NOT DISTINCT FROM (CASE WHEN "last_error" IS NULL THEN NULL ELSE "source_url" END)),
	CONSTRAINT "media_original_error_when_failed" CHECK ("status" <> 'FAILED' OR "last_error" IS NOT NULL),
	CONSTRAINT "media_original_no_error_when_completed" CHECK ("status" <> 'COMPLETED' OR "last_error" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "media_preview" (
	"id" uuid PRIMARY KEY,
	"media_id" uuid NOT NULL,
	"size" "preview_size" NOT NULL,
	"source_file_id" uuid NOT NULL,
	"recipe_version" integer NOT NULL,
	"file_id" uuid,
	"width" integer,
	"height" integer,
	"last_error" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "media_preview_result_or_failure" CHECK (("file_id" IS NOT NULL) <> ("last_error" IS NOT NULL)),
	CONSTRAINT "media_preview_size_with_file" CHECK (("file_id" IS NULL) = ("width" IS NULL) AND ("file_id" IS NULL) = ("height" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "media_tag" (
	"id" uuid PRIMARY KEY,
	"media_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post" (
	"id" uuid PRIMARY KEY,
	"source" "post_source" DEFAULT 'UNKNOWN'::"post_source" NOT NULL,
	"eid" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"author_id" uuid,
	"author_name" text DEFAULT '' NOT NULL,
	"author_external_id" text,
	"published_time" timestamptz,
	"media_count" integer NOT NULL,
	"url" text DEFAULT '',
	"sync_status" "sync_status" DEFAULT 'PENDING'::"sync_status" NOT NULL,
	"user_edited_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"workflow_run_id" text,
	"library_id" uuid NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz,
	"delete_status" "delete_status" DEFAULT 'ACTIVE'::"delete_status" NOT NULL,
	"delete_time" timestamptz,
	"recycle_time" timestamptz,
	CONSTRAINT "post_eid_non_empty" CHECK (btrim("eid") <> ''),
	CONSTRAINT "post_user_edited_fields" CHECK ("user_edited_fields" <@ ARRAY['title', 'description', 'published_time']::text[])
);
--> statement-breakpoint
CREATE TABLE "post_tag" (
	"id" uuid PRIMARY KEY,
	"post_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_patrol" (
	"id" boolean PRIMARY KEY DEFAULT true,
	"patrolled_at" timestamptz NOT NULL,
	CONSTRAINT "queue_patrol_single_row" CHECK ("id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"canonical_tag_id" uuid,
	"color" text,
	"library_id" uuid NOT NULL,
	"status" "tag_status" DEFAULT 'CANDIDATE'::"tag_status" NOT NULL,
	"source" "tag_source" DEFAULT 'SCRAPER'::"tag_source" NOT NULL,
	"source_field" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY,
	"auth_id" text NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_group" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" uuid NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE TABLE "user_group_member" (
	"id" uuid PRIMARY KEY,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "access_role" DEFAULT 'VIEWER'::"access_role" NOT NULL,
	"create_time" timestamptz DEFAULT now() NOT NULL,
	"update_time" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_model_provider_name_unique" ON "ai_model" ("provider_id","name");--> statement-breakpoint
CREATE INDEX "ai_provider_owner_idx" ON "ai_provider" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_metadata_entity_unique" ON "asset_ai_metadata" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "ai_metadata_library_target_idx" ON "asset_ai_metadata" ("library_id","prompt_version","language","model","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_emb_entity_space_unique" ON "asset_embedding" ("entity_type","entity_id","embedding_space_id","embedding_role");--> statement-breakpoint
CREATE INDEX "asset_emb_library_space_role_idx" ON "asset_embedding" ("library_id","embedding_space_id","embedding_role");--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_256" ON "asset_embedding" USING hnsw (("embedding"::halfvec(256)) halfvec_cosine_ops) WHERE "dimension" = 256;--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_384" ON "asset_embedding" USING hnsw (("embedding"::halfvec(384)) halfvec_cosine_ops) WHERE "dimension" = 384;--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_512" ON "asset_embedding" USING hnsw (("embedding"::halfvec(512)) halfvec_cosine_ops) WHERE "dimension" = 512;--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_768" ON "asset_embedding" USING hnsw (("embedding"::halfvec(768)) halfvec_cosine_ops) WHERE "dimension" = 768;--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_1024" ON "asset_embedding" USING hnsw (("embedding"::halfvec(1024)) halfvec_cosine_ops) WHERE "dimension" = 1024;--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_1536" ON "asset_embedding" USING hnsw (("embedding"::halfvec(1536)) halfvec_cosine_ops) WHERE "dimension" = 1536;--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_2048" ON "asset_embedding" USING hnsw (("embedding"::halfvec(2048)) halfvec_cosine_ops) WHERE "dimension" = 2048;--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_2560" ON "asset_embedding" USING hnsw (("embedding"::halfvec(2560)) halfvec_cosine_ops) WHERE "dimension" = 2560;--> statement-breakpoint
CREATE INDEX "asset_emb_hnsw_3072" ON "asset_embedding" USING hnsw (("embedding"::halfvec(3072)) halfvec_cosine_ops) WHERE "dimension" = 3072;--> statement-breakpoint
CREATE UNIQUE INDEX "search_doc_entity_unique" ON "asset_search_document" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "search_doc_folded_title_trgm_idx" ON "asset_search_document" USING gin ("folded_title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_doc_folded_content_trgm_idx" ON "asset_search_document" USING gin ("folded_content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_doc_library_idx" ON "asset_search_document" ("library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "author_library_platform_eid_unique" ON "author" ("library_id","platform","eid");--> statement-breakpoint
CREATE UNIQUE INDEX "av_file_file_unique" ON "av_file" ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "av_stream_file_index_unique" ON "av_stream" ("av_file_id","stream_index");--> statement-breakpoint
CREATE INDEX "job_queue_claim_idx" ON "job_queue" ("priority" DESC NULLS LAST,"available_at");--> statement-breakpoint
CREATE INDEX "job_queue_library_pipeline_idx" ON "job_queue" ("library_id","pipeline");--> statement-breakpoint
CREATE UNIQUE INDEX "library_embedding_space_role_status_unique" ON "library_embedding_space" ("library_id","role","status");--> statement-breakpoint
CREATE UNIQUE INDEX "media_post_source_eid_active_unique" ON "media" ("post_id","source","eid") WHERE "post_id" IS NOT NULL AND "delete_status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "media_library_source_eid_independent_active_unique" ON "media" ("library_id","source","eid") WHERE "post_id" IS NULL AND "delete_status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "media_post_sort_unique" ON "media" ("post_id","sort_order") WHERE delete_status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "media_source_eid_idx" ON "media" ("source","eid");--> statement-breakpoint
CREATE INDEX "media_library_delete_time_idx" ON "media" ("library_id","delete_time");--> statement-breakpoint
CREATE INDEX "media_post_delete_time_idx" ON "media" ("post_id","delete_time");--> statement-breakpoint
CREATE INDEX "media_library_failed_idx" ON "media" ("library_id") WHERE "sync_status" = 'FAILED';--> statement-breakpoint
CREATE INDEX "media_caption_media_idx" ON "media_caption" ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_caption_media_default_unique" ON "media_caption" ("media_id") WHERE "is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "media_caption_media_source_key_unique" ON "media_caption" ("media_id","source_key") WHERE "source_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_cover_media_unique" ON "media_cover" ("media_id");--> statement-breakpoint
CREATE INDEX "media_lyrics_media_idx" ON "media_lyrics" ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_lyrics_media_default_unique" ON "media_lyrics" ("media_id") WHERE "is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "media_lyrics_media_source_key_unique" ON "media_lyrics" ("media_id","source_key") WHERE "source_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "media_original_media_idx" ON "media_original" ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_original_media_source_key_unique" ON "media_original" ("media_id","source_key") WHERE "source_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_preview_media_size_unique" ON "media_preview" ("media_id","size");--> statement-breakpoint
CREATE INDEX "media_preview_failed_idx" ON "media_preview" ("media_id") WHERE "last_error" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_tag_media_tag_unique" ON "media_tag" ("media_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_source_eid_unique" ON "post" ("source","eid");--> statement-breakpoint
CREATE INDEX "post_library_delete_time_idx" ON "post" ("library_id","delete_time");--> statement-breakpoint
CREATE UNIQUE INDEX "post_tag_post_tag_unique" ON "post_tag" ("post_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_library_norm_name_unique" ON "tag" ("library_id","normalized_name");--> statement-breakpoint
ALTER TABLE "ai_model" ADD CONSTRAINT "ai_model_provider_id_ai_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_provider"("id") ON DELETE CASCADE;