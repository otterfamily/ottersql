-- @name userById
select id, email, name, bio, plan, created_at
from users
where id = :id;

-- @name postsWithAuthors
select p.id, p.title, p.status, u.name as author, u.bio
from posts p
left join users u on u.id = p.author_id
order by p.id desc
limit :limit;

-- @name postCountsByStatus
select status, count(*) as total, max(published_on) as latest
from posts
group by status;

-- @name searchPosts
select id, title, coalesce(body, '') as body, array_length(tags, 1) as tag_count
from posts
where title ilike '%' || :term || '%';

-- @name publishedTitles
select id, title, author from published_posts;

-- @name createUser
insert into users (email, name)
values (:email, :name)
returning id, plan, created_at;

-- @name createPost
insert into posts (author_id, title, status, published_on, tags)
values (:authorId, :title, :status, :publishedOn, :tags)
returning id;
