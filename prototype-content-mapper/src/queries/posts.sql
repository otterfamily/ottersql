-- @name latestPublishedPosts
select p.id, p.title, p.status, p.created_at, u.name, u.bio
from posts p
join users u on u.id = p.author_id
where p.author_id = :userId and p.status = 'published'
order by p.created_at desc
limit :limit;

-- @name countByStatus
select status, count(*) as n
from posts
group by status;
