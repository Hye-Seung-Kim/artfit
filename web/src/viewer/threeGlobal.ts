// The Matterport web component sets `window.THREE = window.THREE || <three module namespace>` and the bundle then
// walks it with `hasOwnProperty`. A production (Rollup) namespace object has a null prototype, which breaks that walk
// ("t.hasOwnProperty is not a function"). Matterport's own page copies the namespace into a plain object; do the same
// before the web component module runs. Same three.js instance, so R3F and the scan share classes.
import * as THREE from "three";
(window as any).THREE = (window as any).THREE ?? { ...THREE };
