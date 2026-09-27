(function (global) {
  'use strict';

  var FORMAT = 1;
  var SEED_REV = [0, 'seed'];
  var own = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); };
  var dictionary = function () { return Object.create(null); };

  function fail(code, message, cause) {
    var error = new Error(message || code);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function jsonCopy(value, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
    if (typeof value !== 'object' || Object.prototype.toString.call(value) !== '[object Object]' && !Array.isArray(value)) {
      throw fail('invalidValue', 'Only finite JSON values may be stored.');
    }
    seen = seen || new Set();
    if (seen.has(value)) throw fail('invalidValue', 'Cyclic values cannot be stored.');
    seen.add(value);
    var result;
    if (Array.isArray(value)) {
      result = [];
      for (var i = 0; i < value.length; i += 1) {
        if (!own(value, i)) throw fail('invalidValue', 'Sparse arrays cannot be stored.');
        result.push(jsonCopy(value[i], seen));
      }
    } else {
      result = dictionary();
      Object.keys(value).sort().forEach(function (key) { result[key] = jsonCopy(value[key], seen); });
    }
    seen.delete(value);
    return result;
  }

  function valueMap(value) {
    if (!value || Array.isArray(value) || Object.prototype.toString.call(value) !== '[object Object]') {
      throw fail('invalidValue', 'A cell map is required.');
    }
    return jsonCopy(value);
  }

  function equalValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id); }
  function validRev(rev) {
    return Array.isArray(rev) && rev.length === 2 && Number.isSafeInteger(rev[0]) && rev[0] >= 0 &&
      validId(rev[1]) && (rev[0] !== 0 || rev[1] === 'seed');
  }
  function compareRev(a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1;
  }
  function copyCells(cells) {
    var result = dictionary();
    Object.keys(cells).sort().forEach(function (key) {
      result[key] = { value: jsonCopy(cells[key].value), rev: cells[key].rev.slice() };
    });
    return result;
  }
  function mergeInto(target, source) {
    Object.keys(source).forEach(function (key) {
      var candidate = source[key];
      if (!own(target, key) || compareRev(candidate.rev, target[key].rev) > 0) {
        target[key] = { value: jsonCopy(candidate.value), rev: candidate.rev.slice() };
      } else if (compareRev(candidate.rev, target[key].rev) === 0 && !equalValue(candidate.value, target[key].value)) {
        throw fail('revisionCollision', 'One revision contains different cell values.');
      }
    });
  }
  function revision(cells) {
    var latest = SEED_REV.slice();
    Object.keys(cells).forEach(function (key) {
      if (compareRev(cells[key].rev, latest) > 0) latest = cells[key].rev.slice();
    });
    return latest;
  }
  function exportState(cells) { return { cells: copyCells(cells), revision: revision(cells) }; }
  function strictlyDominates(newCells, oldCells) {
    var oldKeys = Object.keys(oldCells);
    var strict = Object.keys(newCells).length > oldKeys.length;
    for (var i = 0; i < oldKeys.length; i += 1) {
      var key = oldKeys[i];
      if (!own(newCells, key)) return false;
      var order = compareRev(newCells[key].rev, oldCells[key].rev);
      if (order < 0) return false;
      if (order === 0 && !equalValue(newCells[key].value, oldCells[key].value)) return false;
      if (order > 0) strict = true;
    }
    return strict;
  }

  function create(options) {
    options = options || {};
    var namespace = options.namespace || 'fwTax_store_v1';
    if (typeof namespace !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(namespace)) {
      throw fail('invalidNamespace');
    }
    var storage;
    try { storage = options.storage || global.localStorage; }
    catch (error) { throw fail('readFailed', 'Cannot access local storage.', error); }
    if (!storage || typeof options.seed !== 'function') throw fail('invalidOptions');
    var prefix = namespace + ':';
    var markerKey = prefix + 'marker';
    var markerText = JSON.stringify({ format: FORMAT, namespace: namespace });
    var operationMarkerKey = prefix + 'has-operation';
    var seedPrefix = prefix + 'seed:';
    var opPrefix = prefix + 'op:';
    var memory = dictionary();
    var rememberedSeeds = dictionary();
    var hasInitialized = false;

    function readItem(key) {
      try { return storage.getItem(key); }
      catch (error) { throw fail('readFailed', 'Cannot read local storage.', error); }
    }
    function writeItem(key, text) {
      try { storage.setItem(key, text); }
      catch (error) { throw fail('writeFailed', 'Cannot write local storage.', error); }
    }
    function newId() {
      var crypto = global.crypto;
      if (!crypto) throw fail('randomUnavailable');
      if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      if (typeof crypto.getRandomValues !== 'function') throw fail('randomUnavailable');
      var data = new Uint8Array(16);
      crypto.getRandomValues(data);
      return Array.prototype.map.call(data, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
    }
    function unusedId(kind) {
      for (var attempt = 0; attempt < 4; attempt += 1) {
        var id = newId();
        if (!validId(id) || id === 'seed') throw fail('randomUnavailable');
        if (readItem(prefix + kind + ':' + id) === null) return id;
      }
      throw fail('idCollision');
    }
    function parseRecord(key, text) {
      var record;
      try { record = JSON.parse(text); }
      catch (error) { throw fail('corruptSnapshot', 'Snapshot JSON is invalid.', error); }
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw fail('corruptSnapshot');
      if (record.format !== FORMAT) throw fail('unsupportedFormat');
      var kind = key.indexOf(seedPrefix) === 0 ? 'seed' : 'op';
      var id = key.slice((kind === 'seed' ? seedPrefix : opPrefix).length);
      if (!validId(id) || record.kind !== kind || record.id !== id) throw fail('corruptSnapshot');
      if (kind === 'seed') {
        var values = valueMap(record.values);
        var seedCells = dictionary();
        Object.keys(values).forEach(function (field) {
          seedCells[field] = { value: values[field], rev: SEED_REV.slice() };
        });
        return { key: key, id: id, kind: kind, values: values, cells: seedCells };
      }
      if (!record.cells || typeof record.cells !== 'object' || Array.isArray(record.cells)) throw fail('corruptSnapshot');
      var cells = dictionary();
      var hasOwnRevision = false;
      Object.keys(record.cells).forEach(function (field) {
        var cell = record.cells[field];
        if (!cell || typeof cell !== 'object' || !own(cell, 'value') || !validRev(cell.rev)) throw fail('corruptSnapshot');
        cells[field] = { value: jsonCopy(cell.value), rev: cell.rev.slice() };
        if (cell.rev[0] > 0 && cell.rev[1] === id) hasOwnRevision = true;
      });
      if (!hasOwnRevision) throw fail('corruptSnapshot', 'An operation snapshot must include its own revision.');
      return { key: key, id: id, kind: kind, cells: cells };
    }
    function scan() {
      var marker = readItem(markerKey);
      if (marker !== null && marker !== markerText) throw fail('unsupportedFormat');
      var operationMarker = readItem(operationMarkerKey);
      if (operationMarker !== null && operationMarker !== '1') throw fail('unsupportedFormat');
      var records = dictionary();
      // Two scans collect a union; they are not a proof that other tabs are quiescent.
      for (var pass = 0; pass < 2; pass += 1) {
        var count;
        try { count = storage.length; }
        catch (error) { throw fail('readFailed', 'Cannot enumerate local storage.', error); }
        for (var i = 0; i < count; i += 1) {
          var key;
          try { key = storage.key(i); }
          catch (error) { throw fail('readFailed', 'Cannot enumerate local storage.', error); }
          if (typeof key !== 'string' || key.indexOf(seedPrefix) !== 0 && key.indexOf(opPrefix) !== 0) continue;
          var text = readItem(key);
          if (text === null) continue; // Another tab may have compacted this exact immutable key.
          var record = parseRecord(key, text);
          if (own(records, key) && !equalValue(records[key], record)) throw fail('immutableChanged');
          records[key] = record;
        }
      }
      // Recheck after enumeration: a different tab may have completed its first commit meanwhile.
      var finalOperationMarker = readItem(operationMarkerKey);
      if (finalOperationMarker !== null && finalOperationMarker !== '1') throw fail('unsupportedFormat');
      return { marker: marker, operationMarker: operationMarker === '1' || finalOperationMarker === '1', records: records };
    }
    function load() {
      var scanned = scan();
      var records = scanned.records;
      var seeds = dictionary();
      Object.keys(rememberedSeeds).forEach(function (key) { seeds[key] = rememberedSeeds[key]; });
      Object.keys(records).forEach(function (key) {
        if (records[key].kind === 'seed') seeds[key] = records[key];
      });
      if (!Object.keys(seeds).length) {
        if (scanned.marker !== null || scanned.operationMarker || Object.keys(records).length || hasInitialized) throw fail('missingSnapshot');
        // Never import legacy merely because an enumeration briefly omitted another tab's seed.
        if (readItem(markerKey) !== null || readItem(operationMarkerKey) !== null) throw fail('missingSnapshot');
        var seedValues = valueMap(options.seed());
        if (readItem(markerKey) !== null || readItem(operationMarkerKey) !== null) throw fail('missingSnapshot');
        var seedId = unusedId('seed');
        var seedKey = seedPrefix + seedId;
        var seedText = JSON.stringify({ format: FORMAT, kind: 'seed', id: seedId, values: seedValues });
        // Seed first: failure to write the marker must not erase the copied legacy values.
        writeItem(seedKey, seedText);
        records[seedKey] = parseRecord(seedKey, seedText);
        seeds[seedKey] = records[seedKey];
      }
      var seedKeys = Object.keys(seeds).sort();
      var canonicalSeed = seeds[seedKeys[0]];
      for (var s = 1; s < seedKeys.length; s += 1) {
        if (!equalValue(canonicalSeed.values, seeds[seedKeys[s]].values)) throw fail('migrationConflict');
      }
      var merged = copyCells(canonicalSeed.cells);
      mergeInto(merged, memory);
      var observedOperation = false;
      Object.keys(records).forEach(function (key) {
        var record = records[key];
        if (record.kind === 'op') {
          observedOperation = true;
          Object.keys(canonicalSeed.cells).forEach(function (field) {
            if (!own(record.cells, field)) throw fail('corruptSnapshot', 'An operation omitted a baseline cell.');
          });
          mergeInto(merged, record.cells);
        }
      });
      if (scanned.operationMarker && !observedOperation && revision(memory)[0] === 0) {
        throw fail('missingSnapshot', 'Saved operations exist, but no operation snapshot is currently readable.');
      }
      if (scanned.marker === null) writeItem(markerKey, markerText);
      rememberedSeeds = seeds;
      memory = merged;
      hasInitialized = true;
      return { cells: merged, records: records };
    }
    function read() { return exportState(load().cells); }
    function commit(patchValueMap, expectedRevisionMap) {
      var patch = valueMap(patchValueMap);
      var expected = expectedRevisionMap === undefined ? dictionary() : valueMap(expectedRevisionMap);
      Object.keys(expected).forEach(function (key) {
        if (expected[key] !== null && !validRev(expected[key])) throw fail('invalidRevision');
      });
      var loaded = load();
      var conflicts = Object.keys(expected).filter(function (key) {
        var actual = own(loaded.cells, key) ? loaded.cells[key].rev : null;
        return expected[key] === null ? actual !== null : actual === null || compareRev(expected[key], actual) !== 0;
      });
      if (conflicts.length) return { ok: false, conflict: conflicts, state: exportState(loaded.cells) };
      var fields = Object.keys(patch);
      if (!fields.length) return { ok: true, noop: true, state: exportState(loaded.cells) };
      var number = revision(loaded.cells)[0] + 1;
      if (!Number.isSafeInteger(number)) throw fail('revisionOverflow');
      var opId = unusedId('op');
      var opKey = opPrefix + opId;
      var next = copyCells(loaded.cells);
      fields.forEach(function (field) { next[field] = { value: patch[field], rev: [number, opId] }; });
      var text = JSON.stringify({ format: FORMAT, kind: 'op', id: opId, cells: next });
      writeItem(opKey, text);
      memory = next;
      var gcErrors = [];
      // This one-way marker is permanent. If it fails, keep every old operation snapshot.
      try { writeItem(operationMarkerKey, '1'); }
      catch (error) {
        gcErrors.push({ key: operationMarkerKey, code: 'operationMarkerFailed' });
        return { ok: true, operationId: opId, operationRevision: [number, opId], state: exportState(next), gcErrors: gcErrors };
      }
      Object.keys(loaded.records).forEach(function (key) {
        var record = loaded.records[key];
        if (record.kind !== 'op' || !strictlyDominates(next, record.cells)) return;
        try { storage.removeItem(key); }
        catch (error) { gcErrors.push({ key: key, code: 'cleanupFailed' }); }
      });
      return { ok: true, operationId: opId, operationRevision: [number, opId], state: exportState(next), gcErrors: gcErrors };
    }
    return { read: read, commit: commit };
  }

  global.FwLocalStore = Object.freeze({ create: create });
})(typeof window !== 'undefined' ? window : globalThis);
