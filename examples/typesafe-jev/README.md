# examples/typesafe-jev

A **decision-layer** example. The other examples in this repo hand an AlgoVault verdict downstream to an execution platform. This one sits between the verdict and execution.

AlgoVault is the Trading Model API. One API call. One verdict. Not 8 raw indicators. [TypeSafe Jev](https://docs.typesafe.ai) is a System One model: typed decisions with calibrated probabilities. This example hands Jev one AlgoVault composite verdict as structured state and asks whether to act on it now. Code applies every threshold and logs **act**, **hold** or **escalate**.

It never places an order and never touches a wallet or an exchange credential.

## The seam

| Question | Answered by | Why the other cannot |
|---|---|---|
| *What is the market doing?* | **AlgoVault**: composite verdict and regime | TypeSafe documents that Jev is not a calculator; numeric logic belongs in code |
| *Given that, and my position, do I act now?* | **Jev**: typed decision + calibrated probability | AlgoVault does not know the caller's position, exposure, or risk budget and has never claimed to |

`toJevRequest(signal, ctx)` builds the request. It follows Jev's documented limits:

- Every number is bucketed before it reaches `state`. Jev's docs say: "do the conversion in code and pass in either the computed number or a named bucket".
- `state` carries only the fields a question reads.
- Position conflict is a lookup, so code computes it instead of asking Jev.

Jev gets two questions:

| id | type | Question |
|---|---|---|
| `act_now` | Noul | Whether to act on this verdict on this scan rather than wait for the next one. |
| `regime_fit` | Score, 3 levels | How well the reported regime suits a directional entry. Asked only when the verdict carries a regime. |

`decide()` applies `THRESHOLDS` from [`transform.ts`](./transform.ts), in this order:

| Condition | Decision |
|---|---|
| Answered by any model other than `JEV_MODEL` | escalate |
| The verdict conflicts with the open position (computed in code) | escalate |
| `regime_fit` asked and below `THRESHOLDS.regimeFit.min` | hold |
| `act_now` at or above `THRESHOLDS.actNow.act` | act |
| `act_now` at or below `THRESHOLDS.actNow.wait` | hold |
| Anything in between, or a missing or malformed answer | escalate |

`decide()` never throws. A guard on a live decision path refuses rather than crashing the caller.

## Run the example

### Unit tests (no network, no key)

```bash
npm test
```

### Dry run (default)

The dry run needs no TypeSafe key.

```bash
npx tsx examples/typesafe-jev/run.ts
npx tsx examples/typesafe-jev/run.ts --sample
```

- **Default run:** fetches a live verdict from `https://api.algovault.com/mcp` (`get_trade_call`), builds the request and prints the body it would send.
- **HOLD verdict:** the run skips the Jev call and says so.
- **`--sample`:** uses a built-in, labelled sample verdict instead of the live one, with no network.

### `decide()` end to end, without a call

```bash
npx tsx examples/typesafe-jev/run.ts --sample --stub-model jev-1.13.0                    # act
npx tsx examples/typesafe-jev/run.ts --sample --stub-model typesafe-ai/jev               # escalate: model guard
npx tsx examples/typesafe-jev/run.ts --sample --stub-model jev-1.13.0 --position short   # escalate: conflict
```

Stub answers are fixed and labelled `[STUB]`. They are not Jev output.

### Live

```bash
TYPESAFE_API_KEY=... npx tsx examples/typesafe-jev/run.ts --position long
```

`--position long|short|flat` (default `flat`) is your open position. `--position-symbol <SYM>` names the symbol it is on. A position on another symbol is sent as `flat`.

## Transport

Both live legs use the same `@typesafe-ai/sdk` client. The gateway leg changes only `apiKey` and `baseURL`, which is [Vercel's documented migration](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe).

| Env present | Path | `model` sent | Pinned |
|---|---|---|---|
| `TYPESAFE_API_KEY` | `POST https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` | yes |
| else `AI_GATEWAY_API_KEY` | `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | no |
| neither | dry run: print the request body, exit 0 | `jev-1.13.0` | n/a |

## Why the model is pinned

TypeSafe's model aliases move when a new release ships, "so the answers behind it can change without a change on your side" ([docs.typesafe.ai/models](https://docs.typesafe.ai/models)).

- `JEV_MODEL` pins `jev-1.13.0`.
- A unit test rejects any model id that is not `jev-X.Y.Z`.
- `decide()` acts only when the response reports that exact id.

Vercel AI Gateway serves only the unversioned `typesafe-ai/jev` and echoes it back. On that leg `decide()` therefore never acts; it escalates.

`THRESHOLDS` are illustrative defaults. Tune them against the pinned version on your own data, and re-tune when you move the pin.

## Trust boundary

`state` comes from our own AlgoVault MCP, which this example treats as trusted. If you fork it against an untrusted feed, that trust boundary is yours to enforce.

## File map

| File | Purpose |
|---|---|
| [`transform.ts`](./transform.ts) | Pure: `toJevRequest(signal, ctx) → SystemOneRequest \| null`, `conflictsWithPosition()`, `decide()`, `JEV_MODEL`, `THRESHOLDS`. No I/O. |
| [`run.ts`](./run.ts) | Demo: MCP fetch → reshape → `toJevRequest` → dry run, stub or live call → `decide()`. |
| [`tests/transform.test.ts`](./tests/transform.test.ts) | Vitest, zero network. Covers: HOLD skip · float and `merkle_proof` exclusion · the model-pin drift gate · bucket boundaries · position conflict · `decide()` including the model guard. |
| `README.md` | This file. |

## Tested against

- `@typesafe-ai/sdk@0.6.0`. The TypeSafe API (`api.typesafe.ai/v1/systemone`) and Vercel AI Gateway (`ai-gateway.vercel.sh/typesafe/v1/systemone`) were both probed 2026-09-21 for request wiring and auth errors only, not yet with a live key.
- AlgoVault MCP at `https://api.algovault.com/mcp` (`get_trade_call`), 2026-09-21.
- Verifiable-Signal v1.0 spec: [`docs/INTEROP-SPEC-v1.md`](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md).

AlgoVault's public track record: [algovault.com/track-record](https://algovault.com/track-record).

## License

MIT — see [LICENSE](../../LICENSE) at the mono-repo root.
