import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

function computeStreak(dates) {
  // dates: array of 'YYYY-MM-DD' strings, sorted ASC
  if (!dates.length) return { current: 0, best: 0 };

  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Current streak: count consecutive days backward from today/yesterday
  const sortedDesc = [...dates].sort().reverse();
  let current = 0;
  let prevDate = null;
  for (const d of sortedDesc) {
    if (prevDate === null) {
      if (d !== today && d !== yesterday) break;
      current = 1;
    } else {
      const diff = Math.round((new Date(prevDate) - new Date(d)) / 86400000);
      if (diff !== 1) break;
      current++;
    }
    prevDate = d;
  }

  // Best streak: longest run of consecutive days
  const sortedAsc = [...dates].sort();
  let runLen = 1, maxRun = 1;
  for (let i = 1; i < sortedAsc.length; i++) {
    const diff = Math.round((new Date(sortedAsc[i]) - new Date(sortedAsc[i - 1])) / 86400000);
    if (diff === 1) { runLen++; if (runLen > maxRun) maxRun = runLen; }
    else runLen = 1;
  }

  return { current, best: sortedAsc.length > 0 ? maxRun : 0 };
}

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const sql = neon(process.env.DATABASE_URL);

  const safeProduct = `
    CASE
      WHEN done = true
       AND weight IS NOT NULL AND weight > 0
       AND reps ~ '^[0-9]+(\\.[0-9]+)?$'
      THEN weight * reps::numeric
      ELSE 0
    END
  `;

  const [overviewRows, weeklyRows, prRows, bwRows, sessionRows, dateRows] = await Promise.all([

    // 1 — overview totals
    sql`
      SELECT
        COUNT(DISTINCT workout_date)                      AS total_days,
        COUNT(*) FILTER (WHERE done = true)               AS total_sets,
        COALESCE(SUM(
          CASE WHEN done = true
                AND weight IS NOT NULL AND weight > 0
                AND reps ~ '^[0-9]+(\.[0-9]+)?$'
               THEN weight * reps::numeric ELSE 0 END
        ), 0)::bigint                                     AS total_tonnage
      FROM workout_sets
    `,

    // 2 — weekly volume (last 8 weeks)
    sql`
      SELECT
        date_trunc('week', workout_date)::date::text      AS week_start,
        COUNT(*) FILTER (WHERE done = true)               AS sets,
        COALESCE(SUM(
          CASE WHEN done = true
                AND weight IS NOT NULL AND weight > 0
                AND reps ~ '^[0-9]+(\.[0-9]+)?$'
               THEN weight * reps::numeric ELSE 0 END
        ), 0)::bigint                                     AS tonnage,
        COUNT(DISTINCT workout_date)                      AS sessions
      FROM workout_sets
      WHERE workout_date >= CURRENT_DATE - INTERVAL '8 weeks'
      GROUP BY week_start
      ORDER BY week_start ASC
    `,

    // 3 — PRs: heaviest weight per exercise (all time)
    sql`
      SELECT DISTINCT ON (exercise_name)
        exercise_name,
        weight::float            AS weight,
        reps,
        workout_date::text       AS date
      FROM workout_sets
      WHERE done = true
        AND weight IS NOT NULL
        AND weight > 0
      ORDER BY exercise_name, weight DESC, workout_date DESC
    `,

    // 4 — bodyweight history (last 90 entries)
    sql`
      SELECT log_date::text AS date, weight::float AS weight
      FROM bodyweight_logs
      ORDER BY log_date ASC
      LIMIT 90
    `,

    // 5 — recent sessions (last 14 workout days)
    sql`
      SELECT
        ws.workout_date::text                             AS date,
        COUNT(*) FILTER (WHERE ws.done = true)            AS sets,
        COALESCE(SUM(
          CASE WHEN ws.done = true
                AND ws.weight IS NOT NULL AND ws.weight > 0
                AND ws.reps ~ '^[0-9]+(\.[0-9]+)?$'
               THEN ws.weight * ws.reps::numeric ELSE 0 END
        ), 0)::bigint                                     AS tonnage,
        COALESCE(MAX(st.duration_seconds), 0)             AS duration_seconds
      FROM workout_sets ws
      LEFT JOIN session_times st ON st.session_date = ws.workout_date
      GROUP BY ws.workout_date
      ORDER BY ws.workout_date DESC
      LIMIT 14
    `,

    // 6 — all distinct training dates (for streak)
    sql`
      SELECT DISTINCT workout_date::text AS d
      FROM workout_sets
      WHERE done = true
      ORDER BY d ASC
    `,
  ]);

  const streak = computeStreak(dateRows.map(r => r.d));

  return new Response(
    JSON.stringify({
      overview:       overviewRows[0],
      weeklyVolume:   weeklyRows,
      prs:            prRows,
      bodyweight:     bwRows,
      recentSessions: sessionRows,
      streak,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
