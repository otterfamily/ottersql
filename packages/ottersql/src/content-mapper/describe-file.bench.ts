import { benchmarkSchemaSql } from "@ottersql/testing/benchmark-schema";
import { describe, test } from "vitest";

import { openQuerySession } from "./session.ts";

const queryFile = `
-- @name byId
select id, code, note from t1 where id = :id;

-- @name withParent
select t1.code, t0.code as parent_code from t1 left join t0 on t0.id = t1.parent_id;

-- @name innerJoin
select t1.code, t0.code as parent_code from t1 join t0 on t0.id = t1.parent_id;

-- @name fiveWay
select t5.code, t4.code as c4, t3.code as c3, t2.code as c2, t1.code as c1 from t5
  left join t4 on t4.id = t5.parent_id left join t3 on t3.id = t4.parent_id
  join t2 on t2.id = t3.parent_id left join t1 on t1.id = t2.parent_id
where t5.status = :status;

-- @name counts
select status, count(*) as n, max(score) as top from t1 group by status;

-- @name coalesced
select coalesce(note, '') as note, case when score > 0 then 'pos' else 'neg' end as sign from t1;

-- @name unioned
with a as (select code from t1 union all select code from t2) select code from a;

-- @name fromView
select id, code from v1;

-- @name inserted
insert into t1 (code) values (:code) returning id, code, created_at;

-- @name updated
update t1 set note = :note where id = :id returning id, note;
`;

async function openAndClose(): Promise<void> {
  const session = await openQuerySession(benchmarkSchemaSql);
  await session.close();
}

describe("describeFile", () => {
  test("cost on a 50-table schema", async ({ bench }) => {
    const session = await openQuerySession(benchmarkSchemaSql);
    try {
      const describeQueries = async (): Promise<void> => {
        await session.describeFile(queryFile);
      };
      await bench("10 queries of common shapes, described before", describeQueries).run({
        iterations: 50,
        time: 0,
      });
      let edit = 0;
      // A comment changes each query's text, so every iteration misses the cache, as after an edit.
      const describeEdited = async (): Promise<void> => {
        edit += 1;
        await session.describeFile(
          queryFile.replaceAll(
            /^(?<keyword>insert|select|update|with) /gmv,
            `$<keyword> /* ${String(edit)} */ `,
          ),
        );
      };
      await bench("10 queries of common shapes, never described", describeEdited).run({
        iterations: 50,
        time: 0,
      });
    } finally {
      await session.close();
    }
  });

  test("cost of opening a session", async ({ bench }) => {
    await bench("open and close on a 50-table schema", openAndClose).run({
      iterations: 10,
      time: 0,
    });
  });
});
