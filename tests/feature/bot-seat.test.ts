// Add CPU on hosted (mig 375). add_bot_to_session seats the PROVISIONED bot
// auth-user (profiles username 'CPU 🤖', from scripts/create-bot-user.mjs) when
// one exists — on hosted the seat FKs through profiles to auth.users, so the
// old bare-UUID seat failed there. A taken CPU seat errors clearly, and local
// dev without a provisioned profile keeps the bare-UUID fallback.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withRolledBackTx, rpc, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('BOT1 with a provisioned CPU profile the bot seat uses that auth-user', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const cpu = randomUUID()
    await client.query("insert into public.profiles (id, username) values ($1, 'CPU 🤖')", [cpu])

    const botId = await asPlayer(client, s.playerId('A'), () =>
      rpc<string>(client, 'add_bot_to_session', { p_session_id: s.sessionId }),
    )

    assert.equal(botId, cpu)
    const seat = await client.query(
      'select is_bot from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, cpu],
    )
    assert.equal(seat.rows[0]?.is_bot, true)
  })
})

test('BOT2 a second Add CPU errors clearly while the CPU is already seated', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await client.query("insert into public.profiles (id, username) values ($1, 'CPU 🤖')", [randomUUID()])

    await asPlayer(client, s.playerId('A'), () =>
      rpc(client, 'add_bot_to_session', { p_session_id: s.sessionId }),
    )

    await assert.rejects(
      asPlayer(client, s.playerId('A'), () =>
        rpc(client, 'add_bot_to_session', { p_session_id: s.sessionId }),
      ),
      /already seated/,
    )
  })
})

test('BOT4 a fleet of CPU profiles seats distinct bots until it runs dry (mig 376)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const cpu1 = randomUUID()
    const cpu2 = randomUUID()
    await client.query("insert into public.profiles (id, username) values ($1, 'CPU 🤖'), ($2, 'CPU 🤖 2')", [cpu1, cpu2])

    const first = await asPlayer(client, s.playerId('A'), () =>
      rpc<string>(client, 'add_bot_to_session', { p_session_id: s.sessionId }),
    )
    const second = await asPlayer(client, s.playerId('A'), () =>
      rpc<string>(client, 'add_bot_to_session', { p_session_id: s.sessionId }),
    )

    assert.equal(first, cpu1) // name order: 'CPU 🤖' before 'CPU 🤖 2'
    assert.equal(second, cpu2)
    await assert.rejects(
      asPlayer(client, s.playerId('A'), () =>
        rpc(client, 'add_bot_to_session', { p_session_id: s.sessionId }),
      ),
      /already seated/,
    )
  })
})

test('BOT3 without a provisioned profile the bare-UUID fallback still seats a bot', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)

    const botId = await asPlayer(client, s.playerId('A'), () =>
      rpc<string>(client, 'add_bot_to_session', { p_session_id: s.sessionId }),
    )

    const seat = await client.query(
      'select is_bot from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, botId],
    )
    assert.equal(seat.rows[0]?.is_bot, true)
    const prof = await client.query('select 1 from public.profiles where id = $1', [botId])
    assert.equal(prof.rowCount, 0) // bare UUID — no profile row (local relaxed-FK path)
  })
})
