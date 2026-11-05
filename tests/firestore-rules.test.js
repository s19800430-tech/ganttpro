// Firestore 安全規則測試。執行：npm install && npm run test:rules（需要 Java 11+）
// firestore.rules 測試：在 Firestore 模擬器上驗證每個角色能做與不能做的事
const fs = require('fs');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const firebase = require('firebase/compat/app');

const ADMIN = 's19800430@gmail.com';
const users = {
  alice: { uid: 'uidA', email: 'alice@gmail.com' },
  bob:   { uid: 'uidB', email: 'bob@gmail.com' },     // editor
  carol: { uid: 'uidC', email: 'carol@gmail.com' },   // viewer
  eve:   { uid: 'uidE', email: 'eve@gmail.com' },     // registered stranger
  newbie:{ uid: 'uidN', email: 'newbie@gmail.com' },  // not registered
  newbie2:{ uid: 'uidN2', email: 'newbie2@gmail.com' }, // never registers
  admin: { uid: 'uidAdm', email: ADMIN },
};
const results = [];
const EMAIL_OF = { uidA: 'alice@gmail.com', uidB: 'bob@gmail.com', uidN: 'newbie@gmail.com', uidE: 'eve@gmail.com' };
async function t(name, p) {
  try { await p; results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + (e.message || e).toString().slice(0, 160)]); }
}

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'ganttpro-rules-test',
    firestore: { rules: fs.readFileSync(require('path').join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8085 },
  });
  const db = k => env.authenticatedContext(users[k].uid, { email: users[k].email, email_verified: true }).firestore();
  const anon = env.unauthenticatedContext().firestore();
  const FV = firebase.firestore.FieldValue;

  await env.withSecurityRulesDisabled(async ctx => {
    const a = ctx.firestore();
    for (const k of ['alice', 'bob', 'carol', 'eve', 'admin'])
      await a.doc(`gantt_allowed_users/${users[k].email}`).set({ email: users[k].email, name: k, is_admin: k === 'admin', added_at: 'x' });
    await a.doc('gantt_projects/uidA_1').set({ owner_id: 'uidA', owner_email: 'alice@gmail.com', proj_id: 1,
      editor_emails: ['bob@gmail.com'], viewer_emails: ['carol@gmail.com'], project: { name: 'P1', tasks: [] }, rev: 1 });
    await a.doc('gantt_projects/uidA_1/versions/1').set({ id: 1, name: 'v1', snapshot: [] });
    await a.doc('gantt_user_data/uidA').set({ schema: 2, prefs: {} });
    await a.doc('gantt_shares/shr_x').set({ token: 'shr_x', owner_id: 'uidA', project_data: { name: 'P1' } });
    await a.doc('gantt_project_shares/1_bob').set({ project_id: '1', owner_id: 'uidA', shared_with_email: 'bob@gmail.com', permission: 'edit' });
  });

  const P = 'gantt_projects/uidA_1';
  const newDoc = (uid, id) => ({ owner_id: uid, owner_email: 'x', proj_id: id, editor_emails: [], viewer_emails: [], project: { name: 'n', tasks: [] }, rev: 1, updated_at: 'x', updated_by: EMAIL_OF[uid] });

  // ── 專案：建立 ──
  await t('owner creates own project', assertSucceeds(db('alice').doc('gantt_projects/uidA_2').set(newDoc('uidA', 2))));
  await t('cannot create with mismatched docId', assertFails(db('alice').doc('gantt_projects/uidA_99').set(newDoc('uidA', 3))));
  await t('cannot create for another uid', assertFails(db('eve').doc('gantt_projects/uidA_5').set(newDoc('uidA', 5))));
  await t('unregistered user cannot create', assertFails(db('newbie').doc('gantt_projects/uidN_1').set(newDoc('uidN', 1))));
  await t('large Date-based proj_id works', assertSucceeds(db('alice').doc('gantt_projects/uidA_1793670000000123').set(newDoc('uidA', 1793670000000123))));

  // ── 專案：讀取 ──
  await t('owner get missing own doc (tx pre-read)', assertSucceeds(db('alice').doc('gantt_projects/uidA_404').get()));
  await t('stranger get missing doc of someone else', assertFails(db('eve').doc('gantt_projects/uidA_404').get()));
  await t('owner reads project', assertSucceeds(db('alice').doc(P).get()));
  await t('editor reads project', assertSucceeds(db('bob').doc(P).get()));
  await t('viewer reads project', assertSucceeds(db('carol').doc(P).get()));
  await t('stranger cannot read project', assertFails(db('eve').doc(P).get()));
  await t('anon cannot read project', assertFails(anon.doc(P).get()));
  await t('owner query by owner_id', assertSucceeds(db('alice').collection('gantt_projects').where('owner_id', '==', 'uidA').get()));
  await t('editor query array-contains', assertSucceeds(db('bob').collection('gantt_projects').where('editor_emails', 'array-contains', 'bob@gmail.com').get()));
  await t('viewer query array-contains', assertSucceeds(db('carol').collection('gantt_projects').where('viewer_emails', 'array-contains', 'carol@gmail.com').get()));
  await t('stranger cannot list all projects', assertFails(db('eve').collection('gantt_projects').get()));
  await t('stranger cannot query someone else\'s owner_id', assertFails(db('eve').collection('gantt_projects').where('owner_id', '==', 'uidA').get()));
  {
    const snap = await db('bob').collection('gantt_projects').where('editor_emails', 'array-contains', 'bob@gmail.com').get();
    await t('editor query returns the shared project', snap.size === 1 ? Promise.resolve() : Promise.reject('size ' + snap.size));
  }

  // ── 專案：更新 ──
  const bobDb = db('bob');
  await t('editor updates content with rev+1 (transaction)', assertSucceeds(bobDb.runTransaction(async tx => {
    const s = await tx.get(bobDb.doc(P));
    tx.update(bobDb.doc(P), { project: { name: 'by bob', tasks: [] }, rev: s.data().rev + 1, updated_at: 'y', updated_by: 'bob@gmail.com' });
  })));
  await t('editor cannot keep same rev', assertFails(db('bob').doc(P).update({ project: { name: 'x', tasks: [] } })));
  await t('editor cannot change members', assertFails(db('bob').doc(P).update({ editor_emails: FV.arrayUnion('eve@gmail.com'), rev: 3 })));
  await t('editor cannot change owner', assertFails(db('bob').doc(P).update({ owner_id: 'uidB', rev: 3 })));
  await t('viewer cannot update', assertFails(db('carol').doc(P).update({ project: { name: 'x', tasks: [] }, rev: 3 })));
  await t('stranger cannot update', assertFails(db('eve').doc(P).update({ project: { name: 'x', tasks: [] }, rev: 3 })));
  await t('owner adds member (rev unchanged)', assertSucceeds(db('alice').doc(P).update({ viewer_emails: FV.arrayUnion('dave@gmail.com'), editor_emails: FV.arrayRemove('dave@gmail.com') })));
  await t('owner updates content rev+1', assertSucceeds(db('alice').doc(P).update({ project: { name: 'by alice', tasks: [] }, rev: 3, updated_at: 'z', updated_by: 'alice@gmail.com' })));
  await t('editor cannot spoof updated_by', assertFails(db('bob').doc(P).update({ project: { name: 'x', tasks: [] }, rev: 4, updated_at: 'z', updated_by: 'alice@gmail.com' })));
  await t('owner cannot skip rev', assertFails(db('alice').doc(P).update({ rev: 10 })));
  await t('owner cannot transfer ownership', assertFails(db('alice').doc(P).update({ owner_id: 'uidB' })));
  await t('editor cannot delete project', assertFails(db('bob').doc(P).delete()));

  // ── 版本 ──
  const V = P + '/versions/2';
  const ver = (id, by, extra) => ({ id, name: 'v' + id, createdAt: 'x', taskCount: 0, snapshot: [], created_by: by, ...extra });
  await t('owner writes version', assertSucceeds(db('alice').doc(V).set(ver(2, 'alice@gmail.com'))));
  await t('editor creates version', assertSucceeds(db('bob').doc(P + '/versions/3').set(ver(3, 'bob@gmail.com'))));
  await t('version with string id (XSS payload) denied', assertFails(db('bob').doc(P + '/versions/x').set(ver("1);alert(1)//", 'bob@gmail.com'))));
  await t('version doc id must match id', assertFails(db('bob').doc(P + '/versions/77').set(ver(78, 'bob@gmail.com'))));
  await t('version created_by must be self', assertFails(db('bob').doc(P + '/versions/79').set(ver(79, 'alice@gmail.com'))));
  await t('version extra fields denied', assertFails(db('bob').doc(P + '/versions/80').set(ver(80, 'bob@gmail.com', { evil: 1 }))));
  await t('editor cannot overwrite version', assertFails(db('bob').doc(V).set(ver(2, 'bob@gmail.com'))));
  await t('viewer reads versions', assertSucceeds(db('carol').collection(P + '/versions').get()));
  await t('viewer cannot write version', assertFails(db('carol').doc(P + '/versions/4').set(ver(4, 'carol@gmail.com'))));
  await t('stranger cannot read versions', assertFails(db('eve').collection(P + '/versions').get()));
  await t('editor cannot delete version', assertFails(db('bob').doc(P + '/versions/3').delete()));
  await t('owner deletes version', assertSucceeds(db('alice').doc(P + '/versions/3').delete()));

  // ── 個人資料 ──
  await t('own user_data rw', assertSucceeds(db('alice').doc('gantt_user_data/uidA').set({ schema: 2, prefs: { a: 1 } }, { merge: true })));
  await t('cannot read others user_data', assertFails(db('bob').doc('gantt_user_data/uidA').get()));
  await t('cannot write others user_data', assertFails(db('bob').doc('gantt_user_data/uidA').set({ x: 1 })));

  // ── 使用者名單 ──
  await t('self register (not admin)', assertSucceeds(db('newbie').doc('gantt_allowed_users/newbie@gmail.com').set({ email: 'newbie@gmail.com', name: 'N', is_admin: false, added_at: 'x' })));
  await t('self register as admin denied', assertFails(env.authenticatedContext('uidZ', { email: 'z@gmail.com', email_verified: true }).firestore()
    .doc('gantt_allowed_users/z@gmail.com').set({ email: 'z@gmail.com', name: 'Z', is_admin: true, added_at: 'x' })));
  await t('register for someone else denied', assertFails(db('eve').doc('gantt_allowed_users/x@gmail.com').set({ email: 'x@gmail.com', name: 'X', is_admin: false, added_at: 'x' })));
  await t('extra fields denied', assertFails(env.authenticatedContext('uidY', { email: 'y@gmail.com', email_verified: true }).firestore()
    .doc('gantt_allowed_users/y@gmail.com').set({ email: 'y@gmail.com', name: 'Y', is_admin: false, added_at: 'x', role: 'admin' })));
  await t('unverified email cannot register', assertFails(env.authenticatedContext('uidU', { email: 'u@gmail.com', email_verified: false }).firestore()
    .doc('gantt_allowed_users/u@gmail.com').set({ email: 'u@gmail.com', name: 'U', is_admin: false, added_at: 'x' })));
  await t('read own allowed_users (even missing)', assertSucceeds(env.authenticatedContext('uidQ', { email: 'q@gmail.com', email_verified: true }).firestore().doc('gantt_allowed_users/q@gmail.com').get()));
  await t('non-admin cannot list users', assertFails(db('eve').collection('gantt_allowed_users').get()));
  await t('admin lists users', assertSucceeds(db('admin').collection('gantt_allowed_users').orderBy('added_at', 'asc').get()));
  await t('admin deletes user', assertSucceeds(db('admin').doc('gantt_allowed_users/eve@gmail.com').delete()));
  await t('non-admin cannot delete user', assertFails(db('bob').doc('gantt_allowed_users/carol@gmail.com').delete()));

  // ── 分享連結 ──
  await t('anon gets share by token', assertSucceeds(anon.doc('gantt_shares/shr_x').get()));
  await t('anon cannot list shares', assertFails(anon.collection('gantt_shares').get()));
  await t('owner updates own share', assertSucceeds(db('alice').doc('gantt_shares/shr_x').set({ token: 'shr_x', owner_id: 'uidA', project_data: { name: 'P1b' }, updated_at: 'x' })));
  await t('share token must match doc id', assertFails(db('alice').doc('gantt_shares/shr_y').set({ token: 'other', owner_id: 'uidA', project_data: {} })));
  await t('share extra fields denied', assertFails(db('alice').doc('gantt_shares/shr_z').set({ token: 'shr_z', owner_id: 'uidA', project_data: {}, junk: 'x'.repeat(10) })));
  await t('unregistered cannot create share', assertFails(db('newbie2').doc('gantt_shares/shr_n').set({ token: 'shr_n', owner_id: 'uidN2', project_data: {} })));
  await t('other user cannot overwrite share', assertFails(db('bob').doc('gantt_shares/shr_x').set({ token: 'shr_x', owner_id: 'uidB', project_data: {} })));
  await t('create share for self', assertSucceeds(db('bob').doc('gantt_shares/shr_b').set({ token: 'shr_b', owner_id: 'uidB', project_data: {} })));

  // ── 舊版共享（搬遷用）──
  await t('owner queries legacy shares', assertSucceeds(db('alice').collection('gantt_project_shares').where('owner_id', '==', 'uidA').get()));
  await t('others cannot read legacy shares', assertFails(db('bob').collection('gantt_project_shares').where('owner_id', '==', 'uidA').get()));
  await t('cannot create legacy shares', assertFails(db('alice').doc('gantt_project_shares/new').set({ owner_id: 'uidA' })));

  await env.cleanup();
  const fails = results.filter(r => r[0] === 'FAIL');
  results.forEach(r => console.log(r[0], r[1]));
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
