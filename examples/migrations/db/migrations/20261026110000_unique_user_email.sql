-- ottersql:step kind=createIndex object="public.users.users_email_key" phase=contract reversal=reversible transaction=outside lock="share update exclusive"
-- ottersql:cleanup DROP INDEX CONCURRENTLY IF EXISTS "public"."users_email_key";
CREATE UNIQUE INDEX CONCURRENTLY "users_email_key" ON "public"."users" USING btree ("email");

-- ottersql:step kind=addUnique object="public.users.users_email_key" phase=contract reversal=reversible transaction=inside lock="access exclusive"
ALTER TABLE "public"."users" ADD CONSTRAINT "users_email_key" UNIQUE USING INDEX "users_email_key";
