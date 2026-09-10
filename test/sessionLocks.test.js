// Kiro refuses to reopen a session whose lock file names a live pid, and never
// checks the start time it stored beside it — so once Windows reissues that
// number the conversation is unreachable for good. Clearing the lock is the
// repair, and it deletes a file belonging to another program, so the bar for
// deciding one is dead has to be evidence rather than absence of evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  KIRO_IMAGE,
  isStaleLock,
  lockedPidFrom,
  parseSessionLock,
  sessionLockPath,
} = require("../out/sessionLocks");
const { readFacts, lookupProcess } = require("../out/processFacts");

const LOCK_AT = new Date("2026-09-02T09:20:31.777Z");

test("the lock lives where Kiro puts it", () => {
  const p = sessionLockPath("9bf80b1c-9bdb-48d5-a3f7-a91d0974dedb", path.join("C:", "home"));
  assert.equal(
    p,
    path.join("C:", "home", ".kiro", "sessions", "cli", "9bf80b1c-9bdb-48d5-a3f7-a91d0974dedb.lock")
  );
});

/** The real payload, nanosecond fraction and all. */
test("a lock file is read as Kiro writes it", () => {
  const lock = parseSessionLock('{"pid":29752,"started_at":"2026-09-02T09:20:31.777325500Z"}');
  assert.equal(lock.pid, 29752);
  // Date is specified to take three fractional digits; Kiro writes nine.
  assert.equal(lock.startedAt.toISOString(), "2026-09-02T09:20:31.777Z");
});

test("a lock that cannot be read decides nothing", () => {
  for (const text of ["", "{", "null", "{}", '{"pid":0}', '{"pid":-3}', '{"pid":"abc"}']) {
    assert.equal(parseSessionLock(text), undefined, `${JSON.stringify(text)} is not a lock`);
  }
  // A pid with no timestamp is still a lock; the image name can settle it.
  assert.deepEqual(parseSessionLock('{"pid":42}'), { pid: 42 });
  // An unreadable timestamp drops the field rather than poisoning the date.
  assert.deepEqual(parseSessionLock('{"pid":42,"started_at":"soon"}'), { pid: 42 });
});

/*
 * The pid is recognised from Kiro's sentence, and only from that sentence. It
 * arrives as the `data` of a -32603 whose message is the generic "Internal
 * error", so nothing else distinguishes this failure from any other — and a
 * loose match would delete a lock over an unrelated fault.
 */
test("the pid is read out of Kiro's refusal", () => {
  assert.equal(
    lockedPidFrom("Internal error: Failed to start session: Session is active in another process (PID 29752)"),
    29752
  );
  assert.equal(lockedPidFrom("session is active in another process (pid: 8)"), 8);
});

test("any other failure is left alone", () => {
  for (const text of [
    undefined,
    "",
    "Internal error",
    "Unknown session id",
    "Session is active in another process",
    "Kiro is not connected.",
    "the process (PID 29752) is busy",
  ]) {
    assert.equal(lockedPidFrom(text), undefined, `${text} must not look like a stale lock`);
  }
});

test("nothing running under that number means the lock is dead", () => {
  assert.equal(isStaleLock({ pid: 4640, startedAt: LOCK_AT }, { running: false }), true);
});

/*
 * The case that prompted all of this: pid 29752 locked a session on 2 Sep, the
 * agent was killed without cleaning up, and Windows handed the number to a
 * PowerShell. A Kiro session lock is held by a Kiro or by nothing, so the
 * image name alone settles it without needing a clock.
 */
test("a pid that now belongs to another program is a reissued number", () => {
  const facts = { running: true, image: "powershell", startedAt: new Date("2026-09-10T02:00:00Z") };
  assert.equal(isStaleLock({ pid: 29752, startedAt: LOCK_AT }, facts), true);
  // And with no timestamp anywhere, the name is still enough.
  assert.equal(isStaleLock({ pid: 29752 }, { running: true, image: "powershell" }), true);
});

/*
 * A Kiro that started *after* the lock was written cannot be the process that
 * wrote it: the owner is always running before it makes its claim.
 */
test("a newer Kiro under the same number is a reissued number too", () => {
  const facts = { running: true, image: KIRO_IMAGE, startedAt: new Date("2026-09-10T02:00:00Z") };
  assert.equal(isStaleLock({ pid: 29752, startedAt: LOCK_AT }, facts), true);
});

/*
 * The refusals. Deleting a live session's lock lets two agents write one
 * conversation — a worse failure than the one being fixed, and invisible from
 * the panel — so anything short of proof has to leave the file alone.
 */
test("a running Kiro that predates its lock is the owner", () => {
  const facts = {
    running: true,
    image: KIRO_IMAGE,
    startedAt: new Date("2026-09-02T09:20:31.000Z"),
  };
  assert.equal(isStaleLock({ pid: 29752, startedAt: LOCK_AT }, facts), false);
});

test("a running Kiro we cannot date is left alone", () => {
  assert.equal(
    isStaleLock({ pid: 37712, startedAt: LOCK_AT }, { running: true, image: KIRO_IMAGE }),
    false,
    "an unknown start time is not evidence of anything"
  );
  assert.equal(
    isStaleLock({ pid: 37712 }, { running: true, image: KIRO_IMAGE, startedAt: LOCK_AT }),
    false,
    "and neither is a lock that never said when it was taken"
  );
});

test("a process that cannot be identified at all is left alone", () => {
  assert.equal(isStaleLock({ pid: 1, startedAt: LOCK_AT }, { running: true }), false);
});

/*
 * Clock granularity must not condemn the owner. The genuine holder starts
 * before it writes the lock, so a hair the other way is noise, not evidence.
 */
test("a second of clock skew is not proof of anything", () => {
  const facts = {
    running: true,
    image: KIRO_IMAGE,
    startedAt: new Date(LOCK_AT.getTime() + 900),
  };
  assert.equal(isStaleLock({ pid: 29752, startedAt: LOCK_AT }, facts), false);

  const later = { ...facts, startedAt: new Date(LOCK_AT.getTime() + 5000) };
  assert.equal(isStaleLock({ pid: 29752, startedAt: LOCK_AT }, later), true);
});

/* --- what Windows tells us -------------------------------------------- */

test("the process lookup is read as PowerShell prints it", () => {
  const facts = readFacts('{"running":true,"image":"powershell","startedAt":"2026-09-10T02:00:00.0000000Z"}');
  assert.equal(facts.running, true);
  assert.equal(facts.image, "powershell", "lowercased, so the comparison is not case-dependent");
  assert.equal(facts.startedAt.toISOString(), "2026-09-10T02:00:00.000Z");

  assert.deepEqual(readFacts('{"running":false}'), { running: false });
});

/*
 * A lookup that did not work is not evidence a process is gone. Every
 * unreadable answer has to come back as the shape that decides nothing, or a
 * slow PowerShell starts deleting locks.
 */
test("an unreadable lookup claims the process is alive", () => {
  for (const text of ["", "not json", "null", "{}", '{"running":"yes"}']) {
    assert.deepEqual(readFacts(text), { running: true }, `${JSON.stringify(text)} must decide nothing`);
  }
});

test("a lookup that throws claims the process is alive", async () => {
  const facts = await lookupProcess(29752, () => Promise.reject(new Error("powershell is busy")));
  assert.deepEqual(facts, { running: true });
});

test("a pid that is not a pid needs no lookup", async () => {
  let called = false;
  const spy = () => {
    called = true;
    return Promise.resolve("{}");
  };
  for (const pid of [0, -1, 1.5, NaN]) {
    assert.deepEqual(await lookupProcess(pid, spy), { running: false });
  }
  assert.equal(called, false, "nothing should be spawned for a number that cannot be a process");
});

test("the lookup asks about the pid it was given", async () => {
  let script = "";
  await lookupProcess(29752, (s) => {
    script = s;
    return Promise.resolve('{"running":false}');
  });
  assert.match(script, /Get-Process -Id 29752/);
  assert.match(script, /SilentlyContinue/, "a missing process is an answer, not an error");
  assert.match(script, /try \{ \$s = \$p\.StartTime/, "StartTime throws and must not take the rest with it");
});
