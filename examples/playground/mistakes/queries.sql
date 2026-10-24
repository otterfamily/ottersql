-- Each query below is wrong on purpose; VS Code shows where and why.

-- @name unknownColumn
select id, nickname from users;

-- @name unknownTable
select id from comments;

-- @name syntaxError
select id from users where;

-- @name positionalParameter
select id from users where id = $1;

-- @name unknownColumn
select 1;

-- @name delete
select 1;

-- @name twoIds
select u.id, p.id from users u join posts p on p.author_id = u.id;

-- @name unterminated
select 'never closed from users;
