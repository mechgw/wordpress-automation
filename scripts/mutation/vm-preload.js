'use strict';

// Pomost między StrykerJS a harnessem testów (pilot mutacji, zob. docs/quality/mutation-pilot.md).
//
// 1. StrykerJS nie ma parsera dla `.gs`, więc mutowane są kopie `.stryker-shadow/<Nazwa>.js`.
//    Odczyt `src/<Nazwa>.gs` przez harness przekierowujemy na kopię, o ile istnieje.
// 2. Źródła działają w kontekście `vm`, który nie widzi `process.env`, więc zinstrumentowany
//    kod nie dowiedziałby się, który mutant jest aktywny. Wstrzykujemy go do kontekstu.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src') + path.sep;
const SHADOW = path.join(ROOT, '.stryker-shadow');

const readFileSync = fs.readFileSync;
fs.readFileSync = function patchedReadFileSync(file, ...rest) {
  if (typeof file === 'string' && file.startsWith(SRC) && file.endsWith('.gs')) {
    const shadow = path.join(SHADOW, path.basename(file, '.gs') + '.js');
    if (fs.existsSync(shadow)) return readFileSync.call(this, shadow, ...rest);
  }
  return readFileSync.call(this, file, ...rest);
};

const createContext = vm.createContext;
vm.createContext = function patchedCreateContext(obj, ...rest) {
  const target = obj || {};
  const active = process.env.__STRYKER_ACTIVE_MUTANT__;
  if (active !== undefined && target.__stryker__ === undefined) {
    Object.defineProperty(target, '__stryker__', {
      value: { activeMutant: active },
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  return createContext.call(this, target, ...rest);
};
