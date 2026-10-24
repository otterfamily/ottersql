-- ottersql:step kind=createEnum object="public.post_status" phase=expand reversal=lossy transaction=inside lock="none"
CREATE TYPE "public"."post_status" AS ENUM ('draft', 'published');

-- ottersql:step kind=addColumn object="public.posts.status" phase=expand reversal=lossy transaction=inside lock="access exclusive"
ALTER TABLE "public"."posts" ADD COLUMN "status" post_status DEFAULT 'draft'::post_status NOT NULL;

-- ottersql:step kind=createIndex object="public.posts.posts_author_id" phase=expand reversal=reversible transaction=outside lock="share update exclusive"
-- ottersql:cleanup DROP INDEX CONCURRENTLY IF EXISTS "public"."posts_author_id";
CREATE INDEX CONCURRENTLY "posts_author_id" ON "public"."posts" USING btree ("author_id");
