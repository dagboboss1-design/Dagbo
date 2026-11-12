"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SYMBOLS, normalizeCandles, analyze, selectCompletedBefore } = require("../lib/spike-engine");

function candles(count, direction) {
  const rows=[];
  let price=100;
  const start=Date.UTC(2026,0,1,0,0);
  for(let i=0;i<count;i++) {
    const move=direction==="up"?0.12:direction==="down"?-0.12:0.01;
    const open=price;
    const close=price+move;
    rows.push({datetime:new Date(start+i*5*60000).toISOString(),open,
      high:Math.max(open,close)+0.04,low:Math.min(open,close)-0.04,
      close,volume:100+i});
    price=close;
  }
  return rows;
}

test("supports major pairs, crosses, metals and selected CFDs/crypto",()=>{
  for(const pair of ["EURUSD","GBPJPY","AUDNZD","XAUUSD","XAGUSD","US30","US500","BTCUSD"])
    assert.ok(SYMBOLS[pair],pair+" should be mapped");
});

test("normalizes candles into chronological order and drops invalid OHLC",()=>{
  const input=candles(3,"up").reverse();
  input.push({datetime:"bad",open:10,high:9,low:8,close:11});
  const normalized=normalizeCandles(input);
  assert.equal(normalized.length,3);
  assert.ok(Date.parse(normalized[0].datetime)<Date.parse(normalized[2].datetime));
});

test("returns WAIT rather than inventing a result with insufficient candles",()=>{
  const result=analyze(candles(10,"up"),"EURUSD","LIVE",null);
  assert.equal(result.ready,false);
});

test("returns separate spike score and direction agreement fields",()=>{
  const result=analyze(candles(40,"up"),"EURUSD","LIVE",null);
  assert.equal(result.ready,true);
  assert.ok(result.spikeScore>=0 && result.spikeScore<=100);
  assert.ok(result.directionAgreementPct>=0 && result.directionAgreementPct<=100);
  assert.ok(["BUY","SELL","WAIT"].includes(result.direction));
  assert.equal(typeof result.disclaimer,"string");
});

test("pre-news candle selection excludes candles not fully closed before cutoff",()=>{
  const rows=candles(8,"up");
  const cutoff=Date.parse(rows[6].datetime)+5*60000;
  const selected=selectCompletedBefore(rows,cutoff,5,30);
  assert.ok(selected.every(c=>Date.parse(c.datetime)+5*60000<=cutoff));
});
