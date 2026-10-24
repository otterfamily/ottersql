-- ottersql:step kind=createTable object="public.posts" phase=expand reversal=lossy transaction=inside lock="none"
CREATE TABLE "public"."posts" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "author_id" bigint NOT NULL, "title" text NOT NULL, "body" text, CONSTRAINT "posts_pkey" PRIMARY KEY ("id"));

-- ottersql:step kind=createTable object="public.users" phase=expand reversal=lossy transaction=inside lock="none"
CREATE TABLE "public"."users" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "email" text, "name" text NOT NULL, CONSTRAINT "users_pkey" PRIMARY KEY ("id"));

-- ottersql:step kind=addForeignKey object="public.posts.posts_author_id_fkey" phase=expand reversal=reversible transaction=inside lock="share row exclusive"
ALTER TABLE "public"."posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."users" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
