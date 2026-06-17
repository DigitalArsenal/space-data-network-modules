import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import {
  RBK,
  RBKMatrix3T,
  RBKRigidBodyKinematicsRequestT,
  RBKT,
  RBKQuaternionT,
  RBKVector3T,
  rbkEulerSequenceCode,
  rbkOperationCode,
  rbkResultStatus,
} from "../../../../spacedatastandards.org/lib/js/RBK/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const D2R = Math.PI / 180;
const BASILISK_DCM = [
  -0.506611258027956, -0.05213449187759728, 0.860596902153381,
  -0.7789950887797505, -0.4000755572346052, -0.4828107291273137,
  0.3694748772194938, -0.9149981110691346, 0.1620702682281828,
];
const BASILISK_MRP_DCM = [
  0.1420873822677549, 0.4001248192538094, 0.9053790945330048,
  -0.9626904702257736, 0.2686646537364468, 0.03234752493088797,
  -0.2303003133666478, -0.876196001388834, 0.4233702077537369,
];
const BASILISK_MRP_B_MATRIX = [
  0.5625, 1.25, 0.75,
  -0.75, 0.9375, -1,
  -1.25, 0, 0.9375,
];
const BASILISK_MRP_B_INV_MATRIX = [
  0.2304, -0.3072, -0.512,
  0.512, 0.384, 0,
  0.3072, -0.4096, 0.384,
];
const BASILISK_MRP_B_DOT_MATRIX = [
  -0.4583662361046585, 1.7761691649055522, 4.1825919044550091,
  0.6302535746439056, -0.1145915590261646, -4.3544792429942563,
  -6.1306484078998089, -0.9167324722093173, -0.5729577951308232,
];
const BASILISK_EP_FROM_DCM = [0.2526773896521122, 0.4276078901804977, -0.4859180570232927, 0.7191587243944733];
const BASILISK_MRP_FROM_DCM = [0.3413551595269481, -0.3879035903715318, 0.5740973137498672];
const BASILISK_GIBBS_FROM_DCM = [1.692307692307693, -1.923076923076923, 2.846153846153846];
const BASILISK_GIBBS_VECTOR = [0.5746957711326909, -0.7662610281769212, 0.2873478855663454];
const BASILISK_GIBBS_DCM = [
  0.3302752293577981, -0.1530190869107189, 0.9313986428558203,
  -0.7277148580434096, 0.5871559633027522, 0.3545122848941588,
  -0.6011234134980221, -0.794879257371223, 0.08256880733944938,
];
const BASILISK_GIBBS_EP = [0.7071067811865475, 0.4063712768871578, -0.5418283691828771, 0.2031856384435789];
const BASILISK_GIBBS_B_MATRIX = [
  1.0625, 0.625, 0.375,
  -0.375, 1.25, -0.5,
  -0.625, 0, 1.25,
];
const BASILISK_GIBBS_B_INV_MATRIX = [
  0.64, -0.32, -0.32,
  0.32, 0.64, 0.16,
  0.32, -0.16, 0.64,
];
const BASILISK_PRV_FROM_DCM = [1.162634795241009, -1.321175903682964, 1.955340337450788];
const BASILISK_PRV_VECTOR = [0.2, -0.25, 0.3];
const BASILISK_PRV_DCM = [
  0.9249653552860658, 0.2658656942983466, 0.2715778417245783,
  -0.3150687400124018, 0.9360360405717283, 0.1567425271513747,
  -0.212534186867712, -0.2305470957224576, 0.9495668781430935,
];
const BASILISK_PRV_EP = [0.9760338459808767, 0.09919984446969178, -0.1239998055871147, 0.1487997667045377];
const BASILISK_PRV_B_MATRIX = [
  0.95793740211924, 0.26051564947019, 0.23948435052981,
  -0.23948435052981, 0.97371087632453, -0.14603129894038,
  -0.26051564947019, 0.10396870105962, 0.97371087632453,
];
const BASILISK_PRV_B_INV_MATRIX = [
  0.91897927113877, -0.21824360100796, -0.25875396543858,
  0.25875396543858, 0.94936204446173, 0.07873902718102,
  0.21824360100796, -0.15975975604225, 0.94936204446173,
];
const BASILISK_EULER_ANGLES_AS_MRP_INPUT = [30 * D2R, -40 * D2R, 15 * D2R];
const BASILISK_BODY_RATE = [0.2, 0.1, -0.5];
const BASILISK_MRP_DERIVATIVE = [0.0124791041517595, 0.0042760566673861, -0.0043633231299858];
const BASILISK_GIBBS_DERIVATIVE = [0.236312018677072, 0.2405875488560276, -0.1665723597065136];
const BASILISK_PRV_DERIVATIVE = [0.34316538031149, 0.255728121815202, -0.3710557691157747];
const BASILISK_BODY_RATE_FROM_D_MRP = [0.0174532925199433, 0.0349065850398866, -0.0174532925199433];
const BASILISK_BODY_ACCELERATION = [0.0022991473184427, 0.0035194052312667, -0.0070466757773158];
const BASILISK_MRP_SECOND_DERIVATIVE = [0.0015, 0.001, -0.002];
const BASILISK_EULER_COMPOSE_A = [10 * D2R, 20 * D2R, 30 * D2R];
const BASILISK_EULER_COMPOSE_B = [-30 * D2R, 200 * D2R, 81 * D2R];
const BASILISK_EULER_CONVERSION_ANGLES = [0.5746957711326909, -0.7662610281769212, 0.2873478855663454];
const BASILISK_EULER_CONVERSION_EXPECTATIONS = [
  {
    name: "121",
    code: rbkEulerSequenceCode.EULER_121,
    dcm: [
      0.7205084754311385, -0.3769430728235922, 0.5820493593177511,
      -0.1965294640304305, 0.6939446195986547, 0.692688266609151,
      -0.6650140649638986, -0.6134776155495705, 0.4259125598286639,
    ],
    ep: [0.8426692196316502, 0.3875084824890354, -0.3699741829975614, -0.05352444488005169],
    gibbs: [0.4598583565902931, -0.4390503110571495, -0.06351774057138154],
    mrp: [0.2102973655610845, -0.2007816590497557, -0.02904723447366817],
    prv: [0.8184049632304388, -0.7813731087574279, -0.1130418386266624],
  },
  {
    name: "123",
    code: rbkEulerSequenceCode.EULER_123,
    dcm: [
      0.6909668228739537, -0.1236057418710468, 0.7122404581768593,
      -0.2041991989591971, 0.9117724894309838, 0.3563335721781613,
      -0.6934461311680212, -0.391653607277317, 0.6047643467291773,
    ],
    ep: [0.8954752451958283, 0.2088240806958052, -0.3924414987701519, 0.02250019124496444],
    gibbs: [0.2331991663824702, -0.4382494109977661, 0.02512653628972619],
    mrp: [0.1101697746911123, -0.2070412155288303, 0.01187047485953311],
    prv: [0.4328366663508259, -0.8134266388215754, 0.04663690000825693],
  },
  {
    name: "131",
    code: rbkEulerSequenceCode.EULER_131,
    dcm: [
      0.7205084754311385, -0.5820493593177511, -0.3769430728235922,
      0.6650140649638986, 0.4259125598286639, 0.6134776155495705,
      -0.1965294640304305, -0.692688266609151, 0.6939446195986547,
    ],
    ep: [0.8426692196316502, 0.3875084824890354, 0.05352444488005169, -0.3699741829975614],
    gibbs: [0.4598583565902931, 0.06351774057138154, -0.4390503110571495],
    mrp: [0.2102973655610845, 0.02904723447366817, -0.2007816590497557],
    prv: [0.8184049632304388, 0.1130418386266624, -0.7813731087574279],
  },
  {
    name: "132",
    code: rbkEulerSequenceCode.EULER_132,
    dcm: [
      0.6909668228739537, -0.404128912281835, -0.5993702294453531,
      0.6934461311680212, 0.6047643467291773, 0.391653607277317,
      0.2041991989591971, -0.6862506154337003, 0.6981137299618809,
    ],
    ep: [0.8651365354042408, 0.3114838463640192, 0.2322088466732818, -0.3171681574333834],
    gibbs: [0.3600401018996109, 0.2684071671586273, -0.3666105226791566],
    mrp: [0.1670032410235906, 0.1244996504360223, -0.1700509058789317],
    prv: [0.6525765328552258, 0.4864908592507521, -0.6644854907437873],
  },
  {
    name: "212",
    code: rbkEulerSequenceCode.EULER_212,
    dcm: [
      0.6939446195986547, -0.1965294640304305, -0.692688266609151,
      -0.3769430728235922, 0.7205084754311385, -0.5820493593177511,
      0.6134776155495705, 0.6650140649638986, 0.4259125598286639,
    ],
    ep: [0.8426692196316502, -0.3699741829975614, 0.3875084824890354, 0.05352444488005169],
    gibbs: [-0.4390503110571495, 0.4598583565902931, 0.06351774057138154],
    mrp: [-0.2007816590497557, 0.2102973655610845, 0.02904723447366817],
    prv: [-0.7813731087574279, 0.8184049632304388, 0.1130418386266624],
  },
  {
    name: "213",
    code: rbkEulerSequenceCode.EULER_213,
    dcm: [
      0.6981137299618809, 0.2041991989591971, -0.6862506154337003,
      -0.5993702294453531, 0.6909668228739537, -0.404128912281835,
      0.391653607277317, 0.6934461311680212, 0.6047643467291773,
    ],
    ep: [0.8651365354042408, -0.3171681574333834, 0.3114838463640192, 0.2322088466732818],
    gibbs: [-0.3666105226791566, 0.3600401018996109, 0.2684071671586273],
    mrp: [-0.1700509058789317, 0.1670032410235906, 0.1244996504360223],
    prv: [-0.6644854907437873, 0.6525765328552258, 0.4864908592507521],
  },
  {
    name: "231",
    code: rbkEulerSequenceCode.EULER_231,
    dcm: [
      0.6047643467291773, -0.6934461311680212, -0.391653607277317,
      0.7122404581768593, 0.6909668228739537, -0.1236057418710468,
      0.3563335721781613, -0.2041991989591971, 0.9117724894309838,
    ],
    ep: [0.8954752451958283, 0.02250019124496444, 0.2088240806958052, -0.3924414987701519],
    gibbs: [0.02512653628972619, 0.2331991663824702, -0.4382494109977661],
    mrp: [0.01187047485953311, 0.1101697746911123, -0.2070412155288303],
    prv: [0.04663690000825693, 0.4328366663508259, -0.8134266388215754],
  },
  {
    name: "232",
    code: rbkEulerSequenceCode.EULER_232,
    dcm: [
      0.4259125598286639, -0.6650140649638986, -0.6134776155495705,
      0.5820493593177511, 0.7205084754311385, -0.3769430728235922,
      0.692688266609151, -0.1965294640304305, 0.6939446195986547,
    ],
    ep: [0.8426692196316502, -0.05352444488005169, 0.3875084824890354, -0.3699741829975614],
    gibbs: [-0.06351774057138154, 0.4598583565902931, -0.4390503110571495],
    mrp: [-0.02904723447366817, 0.2102973655610845, -0.2007816590497557],
    prv: [-0.1130418386266624, 0.8184049632304388, -0.7813731087574279],
  },
  {
    name: "312",
    code: rbkEulerSequenceCode.EULER_312,
    dcm: [
      0.9117724894309838, 0.3563335721781613, -0.2041991989591971,
      -0.391653607277317, 0.6047643467291773, -0.6934461311680212,
      -0.1236057418710468, 0.7122404581768593, 0.6909668228739537,
    ],
    ep: [0.8954752451958283, -0.3924414987701519, 0.02250019124496444, 0.2088240806958052],
    gibbs: [-0.4382494109977661, 0.02512653628972619, 0.2331991663824702],
    mrp: [-0.2070412155288303, 0.01187047485953311, 0.1101697746911123],
    prv: [-0.8134266388215754, 0.04663690000825693, 0.4328366663508259],
  },
  {
    name: "313",
    code: rbkEulerSequenceCode.EULER_313,
    dcm: [
      0.6939446195986547, 0.692688266609151, -0.1965294640304305,
      -0.6134776155495705, 0.4259125598286639, -0.6650140649638986,
      -0.3769430728235922, 0.5820493593177511, 0.7205084754311385,
    ],
    ep: [0.8426692196316502, -0.3699741829975614, -0.05352444488005169, 0.3875084824890354],
    gibbs: [-0.4390503110571495, -0.06351774057138154, 0.4598583565902931],
    mrp: [-0.2007816590497557, -0.02904723447366817, 0.2102973655610845],
    prv: [-0.7813731087574279, -0.1130418386266624, 0.8184049632304388],
  },
  {
    name: "321",
    code: rbkEulerSequenceCode.EULER_321,
    dcm: [
      0.6047643467291773, 0.391653607277317, 0.6934461311680212,
      -0.6862506154337003, 0.6981137299618809, 0.2041991989591971,
      -0.404128912281835, -0.5993702294453531, 0.6909668228739537,
    ],
    ep: [0.8651365354042408, 0.2322088466732818, -0.3171681574333834, 0.3114838463640192],
    gibbs: [0.2684071671586273, -0.3666105226791566, 0.3600401018996109],
    mrp: [0.1244996504360223, -0.1700509058789317, 0.1670032410235906],
    prv: [0.4864908592507521, -0.6644854907437873, 0.6525765328552258],
  },
  {
    name: "323",
    code: rbkEulerSequenceCode.EULER_323,
    dcm: [
      0.4259125598286639, 0.6134776155495705, 0.6650140649638986,
      -0.692688266609151, 0.6939446195986547, -0.1965294640304305,
      -0.5820493593177511, -0.3769430728235922, 0.7205084754311385,
    ],
    ep: [0.8426692196316502, 0.05352444488005169, -0.3699741829975614, 0.3875084824890354],
    gibbs: [0.06351774057138154, -0.4390503110571495, 0.4598583565902931],
    mrp: [0.02904723447366817, -0.2007816590497557, 0.2102973655610845],
    prv: [0.1130418386266624, -0.7813731087574279, 0.8184049632304388],
  },
];
const BASILISK_EULER_B_EXPECTATIONS = [
  {
    name: "121",
    code: rbkEulerSequenceCode.EULER_121,
    bMatrix: [
      0, -0.40265095531125, -1.50271382293774,
      0, 0.96592582628907, -0.25881904510252,
      1, 0.30844852683273, 1.15114557365953,
    ],
    bInvMatrix: [
      0.76604444311898, 0, 1,
      -0.16636567534280, 0.96592582628907, 0,
      -0.62088515301485, -0.25881904510252, 0,
    ],
  },
  {
    name: "123",
    code: rbkEulerSequenceCode.EULER_123,
    bMatrix: [
      1.26092661459205, -0.33786426809485, 0,
      0.25881904510252, 0.96592582628907, 0,
      0.81050800458377, -0.21717496528718, 1,
    ],
    bInvMatrix: [
      0.73994211169385, 0.25881904510252, 0,
      -0.19826689127415, 0.96592582628907, 0,
      -0.64278760968654, 0, 1,
    ],
  },
  {
    name: "131",
    code: rbkEulerSequenceCode.EULER_131,
    bMatrix: [
      0, 1.50271382293774, -0.40265095531125,
      0, 0.25881904510252, 0.96592582628907,
      1, -1.15114557365953, 0.30844852683273,
    ],
    bInvMatrix: [
      0.76604444311898, 0, 1,
      0.62088515301485, 0.25881904510252, 0,
      -0.16636567534280, 0.96592582628907, 0,
    ],
  },
  {
    name: "132",
    code: rbkEulerSequenceCode.EULER_132,
    bMatrix: [
      1.26092661459205, 0, 0.33786426809485,
      -0.25881904510252, 0, 0.96592582628907,
      -0.81050800458377, 1, -0.21717496528718,
    ],
    bInvMatrix: [
      0.73994211169385, -0.25881904510252, 0,
      0.64278760968654, 0, 1,
      0.19826689127415, 0.96592582628907, 0,
    ],
  },
  {
    name: "212",
    code: rbkEulerSequenceCode.EULER_212,
    bMatrix: [
      -0.40265095531125, 0, 1.50271382293774,
      0.96592582628907, 0, 0.25881904510252,
      0.30844852683273, 1, -1.15114557365953,
    ],
    bInvMatrix: [
      -0.16636567534280, 0.96592582628907, 0,
      0.76604444311898, 0, 1,
      0.62088515301485, 0.25881904510252, 0,
    ],
  },
  {
    name: "213",
    code: rbkEulerSequenceCode.EULER_213,
    bMatrix: [
      0.33786426809485, 1.26092661459205, 0,
      0.96592582628907, -0.25881904510252, 0,
      -0.21717496528718, -0.81050800458377, 1,
    ],
    bInvMatrix: [
      0.19826689127415, 0.96592582628907, 0,
      0.73994211169385, -0.25881904510252, 0,
      0.64278760968654, 0, 1,
    ],
  },
  {
    name: "231",
    code: rbkEulerSequenceCode.EULER_231,
    bMatrix: [
      0, 1.26092661459205, -0.33786426809485,
      0, 0.25881904510252, 0.96592582628907,
      1, 0.81050800458377, -0.21717496528718,
    ],
    bInvMatrix: [
      -0.64278760968654, 0, 1,
      0.73994211169385, 0.25881904510252, 0,
      -0.19826689127415, 0.96592582628907, 0,
    ],
  },
  {
    name: "232",
    code: rbkEulerSequenceCode.EULER_232,
    bMatrix: [
      -1.50271382293774, 0, -0.40265095531125,
      -0.25881904510252, 0, 0.96592582628907,
      1.15114557365953, 1, 0.30844852683273,
    ],
    bInvMatrix: [
      -0.62088515301485, -0.25881904510252, 0,
      0.76604444311898, 0, 1,
      -0.16636567534280, 0.96592582628907, 0,
    ],
  },
  {
    name: "312",
    code: rbkEulerSequenceCode.EULER_312,
    bMatrix: [
      -0.33786426809485, 0, 1.26092661459205,
      0.96592582628907, 0, 0.25881904510252,
      -0.21717496528718, 1, 0.81050800458377,
    ],
    bInvMatrix: [
      -0.19826689127415, 0.96592582628907, 0,
      -0.64278760968654, 0, 1,
      0.73994211169385, 0.25881904510252, 0,
    ],
  },
  {
    name: "313",
    code: rbkEulerSequenceCode.EULER_313,
    bMatrix: [
      -0.40265095531125, -1.50271382293774, 0,
      0.96592582628907, -0.25881904510252, 0,
      0.30844852683273, 1.15114557365953, 1,
    ],
    bInvMatrix: [
      -0.16636567534280, 0.96592582628907, 0,
      -0.62088515301485, -0.25881904510252, 0,
      0.76604444311898, 0, 1,
    ],
  },
  {
    name: "321",
    code: rbkEulerSequenceCode.EULER_321,
    bMatrix: [
      0, 0.33786426809485, 1.26092661459205,
      0, 0.96592582628907, -0.25881904510252,
      1, -0.21717496528718, -0.81050800458377,
    ],
    bInvMatrix: [
      0.64278760968654, 0, 1,
      0.19826689127415, 0.96592582628907, 0,
      0.73994211169385, -0.25881904510252, 0,
    ],
  },
  {
    name: "323",
    code: rbkEulerSequenceCode.EULER_323,
    bMatrix: [
      1.50271382293774, -0.40265095531125, 0,
      0.25881904510252, 0.96592582628907, 0,
      -1.15114557365953, 0.30844852683273, 1,
    ],
    bInvMatrix: [
      0.62088515301485, 0.25881904510252, 0,
      -0.16636567534280, 0.96592582628907, 0,
      0.76604444311898, 0, 1,
    ],
  },
];
const BASILISK_EULER_SEQUENCE_EXPECTATIONS = [
  {
    name: "121",
    code: rbkEulerSequenceCode.EULER_121,
    add: [-2.96705972839036, 2.44346095279206, 1.41371669411541],
    subtract: [2.969124082346242, 2.907100217278789, 2.423943306316236],
    dcmToEuler: [-3.081087141428621, 2.102046098550739, -1.127921895439695],
    derivative: [0.7110918159377425, 0.2260021051801672, -0.3447279341464908],
  },
  {
    name: "123",
    code: rbkEulerSequenceCode.EULER_123,
    add: [2.65556257351773, -0.34257634487528, -2.38843896474589],
    subtract: [3.116108453572625, -0.6539785291371149, -0.9652248604105184],
    dcmToEuler: [1.395488250243478, 0.3784438476398376, 2.147410157986089],
    derivative: [0.2183988961089258, 0.148356391649411, -0.3596158956119647],
  },
  {
    name: "131",
    code: rbkEulerSequenceCode.EULER_131,
    add: [-2.96705972839036, 2.44346095279206, 1.41371669411541],
    subtract: [2.969124082346242, 2.907100217278789, 2.423943306316236],
    dcmToEuler: [1.631301838956069, 2.102046098550739, 0.4428744313552013],
    derivative: [0.3515968599493992, -0.4570810086342821, -0.06933882078231876],
  },
  {
    name: "132",
    code: rbkEulerSequenceCode.EULER_132,
    add: [2.93168877067466, -0.89056295435594, -2.11231276758895],
    subtract: [2.932019083757663, 0.6246626379494424, -1.519867235625338],
    dcmToEuler: [-2.262757475208626, 0.8930615653924096, 2.511467464302149],
    derivative: [0.08325318887098565, -0.5347267221650382, 0.04648588172683711],
  },
  {
    name: "212",
    code: rbkEulerSequenceCode.EULER_212,
    add: [-2.96705972839036, 2.44346095279206, 1.41371669411541],
    subtract: [2.969124082346242, 2.907100217278789, 2.423943306316236],
    dcmToEuler: [-2.125637903992466, 1.982395614047245, -0.05691616561213509],
    derivative: [-0.8318871025311179, 0.06377564270655334, 0.7372624921963103],
  },
  {
    name: "213",
    code: rbkEulerSequenceCode.EULER_213,
    add: [2.93168877067466, -0.89056295435594, -2.11231276758895],
    subtract: [2.932019083757663, 0.6246626379494424, -1.519867235625338],
    dcmToEuler: [1.157420789791818, 1.155503238813826, -3.012011225795042],
    derivative: [0.1936655150781755, 0.1673032607475616, -0.6244857935158128],
  },
  {
    name: "231",
    code: rbkEulerSequenceCode.EULER_231,
    add: [2.65556257351773, -0.34257634487528, -2.38843896474589],
    subtract: [3.116108453572625, -0.6539785291371149, -0.9652248604105185],
    dcmToEuler: [-2.102846464319881, -0.05215813778076988, 1.982990154077466],
    derivative: [0.2950247955066306, -0.4570810086342821, 0.3896382831019671],
  },
  {
    name: "232",
    code: rbkEulerSequenceCode.EULER_232,
    add: [-2.96705972839036, 2.44346095279206, 1.41371669411541],
    subtract: [2.969124082346242, 2.907100217278789, 2.423943306316236],
    dcmToEuler: [-0.5548415771975691, 1.982395614047245, -1.627712492407032],
    derivative: [-0.09921728693192147, -0.5347267221650384, 0.1760048513155397],
  },
  {
    name: "312",
    code: rbkEulerSequenceCode.EULER_312,
    add: [2.65556257351773, -0.34257634487528, -2.38843896474589],
    subtract: [3.116108453572625, -0.653978529137115, -0.9652248604105184],
    dcmToEuler: [2.045248068737305, -0.5038614866151004, -1.384653359078797],
    derivative: [-0.6980361609149971, 0.06377564270655331, -0.3486889953493196],
  },
  {
    name: "313",
    code: rbkEulerSequenceCode.EULER_313,
    add: [-2.96705972839036, 2.44346095279206, 1.41371669411541],
    subtract: [2.969124082346242, 2.907100217278789, 2.423943306316236],
    dcmToEuler: [0.3837766626244829, 1.408008028147626, 2.082059614484753],
    derivative: [-0.2308015733560238, 0.1673032607475616, -0.3231957372675008],
  },
  {
    name: "321",
    code: rbkEulerSequenceCode.EULER_321,
    add: [2.93168877067466, -0.89056295435594, -2.11231276758895],
    subtract: [2.932019083757663, 0.6246626379494424, -1.519867235625338],
    dcmToEuler: [-3.039045355374235, -1.036440549977791, -1.246934586231547],
    derivative: [-0.596676880486542, 0.2260021051801672, 0.5835365057631652],
  },
  {
    name: "323",
    code: rbkEulerSequenceCode.EULER_323,
    add: [-2.96705972839036, 2.44346095279206, 1.41371669411541],
    subtract: [2.969124082346242, 2.907100217278789, 2.423943306316236],
    dcmToEuler: [-1.187019664170414, 1.408008028147626, -2.630329365899936],
    derivative: [0.260277669056422, 0.148356391649411, -0.6993842620486324],
  },
];

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function encodeRequest({
  operation,
  vectorA = null,
  vectorB = null,
  vectorC = null,
  vectorD = null,
  quaternionA = null,
  matrixA = null,
  switchThreshold = 0,
  eulerSequence = rbkEulerSequenceCode.UNKNOWN,
  angleRad = 0,
}) {
  const builder = new flatbuffers.Builder(1024);
  const request = new RBKRigidBodyKinematicsRequestT(
    operation,
    vectorA === null ? null : new RBKVector3T(...vectorA),
    vectorB === null ? null : new RBKVector3T(...vectorB),
    quaternionA === null ? null : new RBKQuaternionT(...quaternionA),
    matrixA === null ? null : new RBKMatrix3T(...matrixA),
    switchThreshold,
    `basilisk-avs-${rbkOperationCode[operation]}`,
    vectorC === null ? null : new RBKVector3T(...vectorC),
    vectorD === null ? null : new RBKVector3T(...vectorD),
    eulerSequence,
    angleRad,
  );
  const root = new RBKT(request, null).pack(builder);
  RBK.finishRBKBuffer(builder, root);
  return builder.asUint8Array();
}

async function invokeRigidBodyKinematics(harness, payload) {
  return harness.invoke({
    methodId: "evaluate_rigid_body_kinematics",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "RBK.fbs",
          fileIdentifier: "$RBK",
          rootTypeName: "RBK",
        },
        payload,
      },
    ],
  });
}

function decodeResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.equal(frame.typeRef?.schemaName, "RBK.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$RBK");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(RBK.bufferHasIdentifier(bb), true);
  const envelope = RBK.getRootAsRBK(bb);
  const result = envelope.RIGID_BODY_RESULT();
  assert.ok(result, "missing RBK.RIGID_BODY_RESULT");
  assert.equal(result.STATUS(), rbkResultStatus.OK, result.ERROR_MESSAGE());
  return result;
}

function assertNear(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  assert.ok(delta <= tolerance, `${label} delta ${delta} exceeds ${tolerance}; actual=${actual}, expected=${expected}`);
}

function assertVectorNear(record, expected, tolerance, label) {
  assert.ok(record, `missing ${label}`);
  assertNear(record.X(), expected[0], tolerance, `${label}.X`);
  assertNear(record.Y(), expected[1], tolerance, `${label}.Y`);
  assertNear(record.Z(), expected[2], tolerance, `${label}.Z`);
}

function assertQuaternionNear(record, expected, tolerance, label) {
  assert.ok(record, `missing ${label}`);
  assertNear(record.Q0(), expected[0], tolerance, `${label}.Q0`);
  assertNear(record.Q1(), expected[1], tolerance, `${label}.Q1`);
  assertNear(record.Q2(), expected[2], tolerance, `${label}.Q2`);
  assertNear(record.Q3(), expected[3], tolerance, `${label}.Q3`);
}

function assertMatrixNear(record, expected, tolerance, label) {
  assert.ok(record, `missing ${label}`);
  const actual = [
    record.M11(), record.M12(), record.M13(),
    record.M21(), record.M22(), record.M23(),
    record.M31(), record.M32(), record.M33(),
  ];
  for (let index = 0; index < expected.length; index += 1) {
    assertNear(actual[index], expected[index], tolerance, `${label}[${index}]`);
  }
}

async function withHarness(t, callback) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  await callback(harness);
}

// Authoritative numerical source:
// Basilisk `src/architecture/utilitiesSelfCheck/avsLibrarySelfCheck/avsLibrarySelfCheck.c`
// exercises these vectors through `testRigidBodyKinematics()` with an upstream
// tolerance of 1e-10.

test("build publishes canonical isomorphic artifact path", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)));
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_avsEigenSupport.cpp`
// exercises `eigenTilde(Eigen::Vector3d(1, 2, 3))` with 1e-10 tolerances.
test("matches Basilisk avsEigenSupport tilde matrix", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.TILDE_MATRIX,
          vectorA: [1, 2, 3],
        }),
      ),
    );
    assertMatrixNear(
      result.MATRIX(),
      [
        0, -3, 2,
        3, 0, -1,
        -2, 1, 0,
      ],
      1e-10,
      "TILDE_MATRIX",
    );
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_avsEigenSupport.cpp`
// exercises `eigenM1`, `eigenM2`, and `eigenM3` at pi/4 with 1e-10 tolerances.
test("matches Basilisk avsEigenSupport elementary rotation matrices", async (t) => {
  await withHarness(t, async (harness) => {
    const angleRad = Math.PI / 4;
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    const cases = [
      {
        operation: rbkOperationCode.M1_ROTATION_MATRIX,
        expected: [
          1, 0, 0,
          0, c, s,
          0, -s, c,
        ],
        label: "M1_ROTATION_MATRIX",
      },
      {
        operation: rbkOperationCode.M2_ROTATION_MATRIX,
        expected: [
          c, 0, -s,
          0, 1, 0,
          s, 0, c,
        ],
        label: "M2_ROTATION_MATRIX",
      },
      {
        operation: rbkOperationCode.M3_ROTATION_MATRIX,
        expected: [
          c, s, 0,
          -s, c, 0,
          0, 0, 1,
        ],
        label: "M3_ROTATION_MATRIX",
      },
    ];

    for (const entry of cases) {
      const result = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: entry.operation,
            angleRad,
          }),
        ),
      );
      assertMatrixNear(result.MATRIX(), entry.expected, 1e-10, entry.label);
    }
  });
});

// Authoritative numerical source:
// Basilisk `src/architecture/utilities/tests/test_avsEigenSupport.cpp`
// exercises `eigenC2MRP` for a 90 degree third-axis DCM with 1e-6 tolerances.
test("matches Basilisk avsEigenSupport DCMtoMRP reference", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DCM_TO_MRP,
          matrixA: [
            0, 1, 0,
            -1, 0, 0,
            0, 0, 1,
          ],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0, 0, 0.41421356], 1e-6, "DCM_TO_MRP_AVS_EIGEN");
  });
});

test("matches Basilisk AVS addMRP composition vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.ADD_MRP,
          vectorA: [1.5, 0.5, 0.5],
          vectorB: [-0.5, 0.25, 0.15],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.58667769962764, -0.349193214729, 0.43690525444766], 1e-10, "ADD_MRP");
  });
});

test("matches Basilisk AVS addMRP 360 degree composition vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.ADD_MRP,
          vectorA: [0, 0, 1],
          vectorB: [0, 0, 1],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0, 0, 0], 1e-10, "ADD_MRP_360");
  });
});

test("matches Basilisk AVS subMRP relative rotation vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.SUB_MRP,
          vectorA: [1.5, 0.5, 0.5],
          vectorB: [-0.5, 0.25, 0.15],
        }),
      ),
    );
    assertVectorNear(
      result.VECTOR(),
      [-0.005376344086021518, 0.04301075268817203, -0.4408602150537635],
      1e-10,
      "SUB_MRP",
    );
  });
});

test("matches Basilisk AVS subMRP 360 degree subtraction vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.SUB_MRP,
          vectorA: [0, 0, 1],
          vectorB: [0, 0, -1],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0, 0, 0], 1e-10, "SUB_MRP_360");
  });
});

test("matches Basilisk AVS addGibbs composition vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.ADD_GIBBS,
          vectorA: [1.5, 0.5, 0.5],
          vectorB: [-0.5, 0.25, 0.15],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.61290322580645, 0.17741935483871, 0.82258064516129], 1e-10, "ADD_GIBBS");
  });
});

test("matches Basilisk AVS subGibbs relative rotation vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.SUB_GIBBS,
          vectorA: [1.5, 0.5, 0.5],
          vectorB: [-0.5, 0.25, 0.15],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [4.333333333333333, -0.5, 2.166666666666667], 1e-10, "SUB_GIBBS");
  });
});

test("matches Basilisk AVS addPRV composition vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.ADD_PRV,
          vectorA: [1.5, 0.5, 0.5],
          vectorB: [-0.5, 0.25, 0.15],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [1.00227389370983, 0.41720669426711, 0.86837149207759], 1e-10, "ADD_PRV");
  });
});

test("matches Basilisk AVS subPRV relative rotation vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.SUB_PRV,
          vectorA: [1.5, 0.5, 0.5],
          vectorB: [-0.5, 0.25, 0.15],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [1.899971363060601, 0.06138537390284331, 0.7174863730592785], 1e-10, "SUB_PRV");
  });
});

test("matches Basilisk AVS addEuler composition vectors for all sequences", async (t) => {
  await withHarness(t, async (harness) => {
    for (const sequence of BASILISK_EULER_SEQUENCE_EXPECTATIONS) {
      const result = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.ADD_EULER,
            vectorA: BASILISK_EULER_COMPOSE_A,
            vectorB: BASILISK_EULER_COMPOSE_B,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(result.VECTOR(), sequence.add, 1e-10, `ADD_EULER_${sequence.name}`);
    }
  });
});

test("matches Basilisk AVS subEuler relative rotation vectors for all sequences", async (t) => {
  await withHarness(t, async (harness) => {
    for (const sequence of BASILISK_EULER_SEQUENCE_EXPECTATIONS) {
      const result = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.SUB_EULER,
            vectorA: BASILISK_EULER_COMPOSE_A,
            vectorB: BASILISK_EULER_COMPOSE_B,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(result.VECTOR(), sequence.subtract, 1e-10, `SUB_EULER_${sequence.name}`);
    }
  });
});

test("matches Basilisk AVS C2Euler vectors for all sequences", async (t) => {
  await withHarness(t, async (harness) => {
    for (const sequence of BASILISK_EULER_SEQUENCE_EXPECTATIONS) {
      const result = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.DCM_TO_EULER,
            matrixA: BASILISK_DCM,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(result.VECTOR(), sequence.dcmToEuler, 1e-10, `DCM_TO_EULER_${sequence.name}`);
    }
  });
});

test("matches Basilisk AVS Euler2C matrices for all sequences", async (t) => {
  await withHarness(t, async (harness) => {
    for (const sequence of BASILISK_EULER_CONVERSION_EXPECTATIONS) {
      const result = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.EULER_TO_DCM,
            vectorA: BASILISK_EULER_CONVERSION_ANGLES,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertMatrixNear(result.MATRIX(), sequence.dcm, 1e-10, `EULER_TO_DCM_${sequence.name}`);
    }
  });
});

test("matches Basilisk AVS Euler representation conversion vectors for all sequences", async (t) => {
  await withHarness(t, async (harness) => {
    for (const sequence of BASILISK_EULER_CONVERSION_EXPECTATIONS) {
      const ep = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.EULER_TO_EP,
            vectorA: BASILISK_EULER_CONVERSION_ANGLES,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertQuaternionNear(ep.QUATERNION(), sequence.ep, 1e-10, `EULER_TO_EP_${sequence.name}`);

      const gibbs = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.EULER_TO_GIBBS,
            vectorA: BASILISK_EULER_CONVERSION_ANGLES,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(gibbs.VECTOR(), sequence.gibbs, 1e-10, `EULER_TO_GIBBS_${sequence.name}`);

      const mrp = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.EULER_TO_MRP,
            vectorA: BASILISK_EULER_CONVERSION_ANGLES,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(mrp.VECTOR(), sequence.mrp, 1e-10, `EULER_TO_MRP_${sequence.name}`);

      const prv = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.EULER_TO_PRV,
            vectorA: BASILISK_EULER_CONVERSION_ANGLES,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(prv.VECTOR(), sequence.prv, 1e-10, `EULER_TO_PRV_${sequence.name}`);
    }
  });
});

test("matches Basilisk AVS representation-to-Euler conversion vectors for all sequences", async (t) => {
  await withHarness(t, async (harness) => {
    for (const sequence of BASILISK_EULER_SEQUENCE_EXPECTATIONS) {
      const ep = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.EP_TO_EULER,
            quaternionA: BASILISK_EP_FROM_DCM,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(ep.VECTOR(), sequence.dcmToEuler, 1e-10, `EP_TO_EULER_${sequence.name}`);

      const mrp = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.MRP_TO_EULER,
            vectorA: BASILISK_MRP_FROM_DCM,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(mrp.VECTOR(), sequence.dcmToEuler, 1e-10, `MRP_TO_EULER_${sequence.name}`);

      const gibbs = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.GIBBS_TO_EULER,
            vectorA: BASILISK_GIBBS_FROM_DCM,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(gibbs.VECTOR(), sequence.dcmToEuler, 1e-10, `GIBBS_TO_EULER_${sequence.name}`);

      const prv = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.PRV_TO_EULER,
            vectorA: BASILISK_PRV_FROM_DCM,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(prv.VECTOR(), sequence.dcmToEuler, 1e-10, `PRV_TO_EULER_${sequence.name}`);
    }
  });
});

test("matches Basilisk AVS Euler B and inverse B matrices for all sequences", async (t) => {
  await withHarness(t, async (harness) => {
    for (const sequence of BASILISK_EULER_B_EXPECTATIONS) {
      const bMatrix = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.B_MATRIX_EULER,
            vectorA: BASILISK_EULER_ANGLES_AS_MRP_INPUT,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertMatrixNear(bMatrix.MATRIX(), sequence.bMatrix, 1e-10, `B_MATRIX_EULER_${sequence.name}`);

      const bInvMatrix = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.B_INV_MATRIX_EULER,
            vectorA: BASILISK_EULER_ANGLES_AS_MRP_INPUT,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertMatrixNear(bInvMatrix.MATRIX(), sequence.bInvMatrix, 1e-10, `B_INV_MATRIX_EULER_${sequence.name}`);
    }
  });
});

test("matches Basilisk AVS dEuler derivative vectors for all sequences", async (t) => {
  await withHarness(t, async (harness) => {
    for (const sequence of BASILISK_EULER_SEQUENCE_EXPECTATIONS) {
      const result = decodeResult(
        await invokeRigidBodyKinematics(
          harness,
          encodeRequest({
            operation: rbkOperationCode.D_EULER,
            vectorA: BASILISK_EULER_ANGLES_AS_MRP_INPUT,
            vectorB: BASILISK_BODY_RATE,
            eulerSequence: sequence.code,
          }),
        ),
      );
      assertVectorNear(result.VECTOR(), sequence.derivative, 1e-10, `D_EULER_${sequence.name}`);
    }
  });
});

test("matches Basilisk AVS MRPswitch unchanged branch", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.MRP_SWITCH,
          vectorA: [0.2, -0.25, 0.3],
          switchThreshold: 1,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.2, -0.25, 0.3], 1e-10, "MRP_SWITCH_UNCHANGED");
  });
});

test("matches Basilisk AVS MRPswitch shadow branch", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.MRP_SWITCH,
          vectorA: [0.2, -0.25, 0.3],
          switchThreshold: 0.4,
        }),
      ),
    );
    assertVectorNear(
      result.VECTOR(),
      [-1.038961038961039, 1.298701298701299, -1.558441558441558],
      1e-10,
      "MRP_SWITCH_SHADOW",
    );
  });
});

test("matches Basilisk AVS MRP2EP quaternion conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.MRP_TO_EP,
          vectorA: [0.2, -0.25, 0.3],
        }),
      ),
    );
    assertQuaternionNear(
      result.QUATERNION(),
      [0.6771488469601677, 0.3354297693920336, -0.419287211740042, 0.5031446540880503],
      1e-10,
      "MRP_TO_EP",
    );
  });
});

test("matches Basilisk AVS EP2MRP vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.EP_TO_MRP,
          quaternionA: [0.2526773896521122, 0.4276078901804977, -0.4859180570232927, 0.7191587243944733],
        }),
      ),
    );
    assertVectorNear(
      result.VECTOR(),
      [0.3413551595269481, -0.3879035903715319, 0.5740973137498672],
      1e-10,
      "EP_TO_MRP",
    );
  });
});

test("matches Basilisk AVS EP2Gibbs vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.EP_TO_GIBBS,
          quaternionA: BASILISK_EP_FROM_DCM,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_GIBBS_FROM_DCM, 1e-10, "EP_TO_GIBBS");
  });
});

test("matches Basilisk AVS Gibbs2EP quaternion conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.GIBBS_TO_EP,
          vectorA: BASILISK_GIBBS_VECTOR,
        }),
      ),
    );
    assertQuaternionNear(result.QUATERNION(), BASILISK_GIBBS_EP, 1e-10, "GIBBS_TO_EP");
  });
});

test("matches Basilisk AVS EP2PRV vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    let result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.EP_TO_PRV,
          quaternionA: BASILISK_EP_FROM_DCM,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_PRV_FROM_DCM, 1e-10, "EP_TO_PRV");

    result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.EP_TO_PRV,
          quaternionA: [1, 0, 0, 0],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0, 0, 0], 1e-10, "EP_TO_PRV_IDENTITY");

    result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.EP_TO_PRV,
          quaternionA: [0, 1, 0, 0],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [Math.PI, 0, 0], 1e-10, "EP_TO_PRV_PI");
  });
});

test("matches Basilisk AVS PRV2EP quaternion conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.PRV_TO_EP,
          vectorA: BASILISK_PRV_VECTOR,
        }),
      ),
    );
    assertQuaternionNear(result.QUATERNION(), BASILISK_PRV_EP, 1e-10, "PRV_TO_EP");
  });
});

test("matches Basilisk AVS C2EP quaternion conversion from DCM", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DCM_TO_EP,
          matrixA: BASILISK_DCM,
        }),
      ),
    );
    assertQuaternionNear(
      result.QUATERNION(),
      BASILISK_EP_FROM_DCM,
      1e-10,
      "DCM_TO_EP",
    );
  });
});

test("matches Basilisk AVS EP2C direction cosine matrix conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.EP_TO_DCM,
          quaternionA: [0.2526773896521122, 0.4276078901804977, -0.4859180570232927, 0.7191587243944733],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_DCM, 1e-10, "EP_TO_DCM");
  });
});

test("matches Basilisk AVS C2Gibbs vector conversion from DCM", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DCM_TO_GIBBS,
          matrixA: BASILISK_DCM,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_GIBBS_FROM_DCM, 1e-10, "DCM_TO_GIBBS");
  });
});

test("matches Basilisk AVS Gibbs2C direction cosine matrix conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.GIBBS_TO_DCM,
          vectorA: BASILISK_GIBBS_VECTOR,
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_GIBBS_DCM, 1e-10, "GIBBS_TO_DCM");
  });
});

test("matches Basilisk AVS C2PRV vector conversion from DCM", async (t) => {
  await withHarness(t, async (harness) => {
    let result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DCM_TO_PRV,
          matrixA: BASILISK_DCM,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_PRV_FROM_DCM, 1e-10, "DCM_TO_PRV");

    result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DCM_TO_PRV,
          matrixA: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0, 0, 0], 1e-10, "DCM_TO_PRV_IDENTITY");

    result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DCM_TO_PRV,
          matrixA: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0, 0, Math.PI], 1e-10, "DCM_TO_PRV_PI");
  });
});

test("matches Basilisk AVS PRV2C direction cosine matrix conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.PRV_TO_DCM,
          vectorA: BASILISK_PRV_VECTOR,
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_PRV_DCM, 1e-10, "PRV_TO_DCM");
  });
});

test("matches Basilisk AVS C2MRP vector conversion from DCM", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DCM_TO_MRP,
          matrixA: BASILISK_DCM,
        }),
      ),
    );
    assertVectorNear(
      result.VECTOR(),
      [0.3413551595269481, -0.3879035903715318, 0.5740973137498672],
      1e-10,
      "DCM_TO_MRP",
    );
  });
});

test("matches Basilisk AVS MRP2C direction cosine matrix conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.MRP_TO_DCM,
          vectorA: [0.2, -0.25, 0.3],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_MRP_DCM, 1e-10, "MRP_TO_DCM");
  });
});

test("matches Basilisk AVS MRP2Gibbs vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.MRP_TO_GIBBS,
          vectorA: [0.2, -0.25, 0.3],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.4953560371517029, -0.6191950464396285, 0.7430340557275542], 1e-10, "MRP_TO_GIBBS");
  });
});

test("matches Basilisk AVS Gibbs2MRP vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.GIBBS_TO_MRP,
          vectorA: BASILISK_GIBBS_VECTOR,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.2380467826416248, -0.3173957101888331, 0.1190233913208124], 1e-10, "GIBBS_TO_MRP");
  });
});

test("matches Basilisk AVS MRP2PRV vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    let result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.MRP_TO_PRV,
          vectorA: [0.2, -0.25, 0.3],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.7538859486650076, -0.9423574358312593, 1.130828922997511], 1e-10, "MRP_TO_PRV");

    result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.MRP_TO_PRV,
          vectorA: [1, 0, 0],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [Math.PI, 0, 0], 1e-10, "MRP_TO_PRV_PI");
  });
});

test("matches Basilisk AVS PRV2MRP vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.PRV_TO_MRP,
          vectorA: BASILISK_PRV_VECTOR,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.05020149056224809, -0.06275186320281011, 0.07530223584337212], 1e-10, "PRV_TO_MRP");
  });
});

test("matches Basilisk AVS Gibbs2PRV vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    let result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.GIBBS_TO_PRV,
          vectorA: BASILISK_GIBBS_VECTOR,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.9027300063197914, -1.203640008426389, 0.4513650031598956], 1e-10, "GIBBS_TO_PRV");

    result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.GIBBS_TO_PRV,
          vectorA: [0, 0, 0],
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0, 0, 0], 1e-10, "GIBBS_TO_PRV_ZERO");
  });
});

test("matches Basilisk AVS PRV2Gibbs vector conversion", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.PRV_TO_GIBBS,
          vectorA: BASILISK_PRV_VECTOR,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.1016356603597079, -0.1270445754496348, 0.1524534905395618], 1e-10, "PRV_TO_GIBBS");
  });
});

test("matches Basilisk AVS BmatMRP matrix", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.B_MATRIX_MRP,
          vectorA: [0.25, 0.5, -0.5],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_MRP_B_MATRIX, 1e-10, "B_MATRIX_MRP");
  });
});

test("matches Basilisk AVS BinvMRP matrix", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.B_INV_MATRIX_MRP,
          vectorA: [0.25, 0.5, -0.5],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_MRP_B_INV_MATRIX, 1e-10, "B_INV_MATRIX_MRP");
  });
});

test("matches Basilisk AVS BmatGibbs matrix", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.B_MATRIX_GIBBS,
          vectorA: [0.25, 0.5, -0.5],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_GIBBS_B_MATRIX, 1e-10, "B_MATRIX_GIBBS");
  });
});

test("matches Basilisk AVS BinvGibbs matrix", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.B_INV_MATRIX_GIBBS,
          vectorA: [0.25, 0.5, -0.5],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_GIBBS_B_INV_MATRIX, 1e-10, "B_INV_MATRIX_GIBBS");
  });
});

test("matches Basilisk AVS BmatPRV matrix", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.B_MATRIX_PRV,
          vectorA: [0.25, 0.5, -0.5],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_PRV_B_MATRIX, 1e-10, "B_MATRIX_PRV");
  });
});

test("matches Basilisk AVS BinvPRV matrix", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.B_INV_MATRIX_PRV,
          vectorA: [0.25, 0.5, -0.5],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_PRV_B_INV_MATRIX, 1e-10, "B_INV_MATRIX_PRV");
  });
});

test("matches Basilisk AVS dMRP derivative vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.D_MRP,
          vectorA: BASILISK_EULER_ANGLES_AS_MRP_INPUT,
          vectorB: BASILISK_BODY_RATE,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), [0.144807895231133, 0.1948354871330581, 0.062187948908334], 1e-10, "D_MRP");
  });
});

test("matches Basilisk AVS dGibbs derivative vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.D_GIBBS,
          vectorA: BASILISK_EULER_ANGLES_AS_MRP_INPUT,
          vectorB: BASILISK_BODY_RATE,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_GIBBS_DERIVATIVE, 1e-10, "D_GIBBS");
  });
});

test("matches Basilisk AVS dPRV derivative vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.D_PRV,
          vectorA: BASILISK_EULER_ANGLES_AS_MRP_INPUT,
          vectorB: BASILISK_BODY_RATE,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_PRV_DERIVATIVE, 1e-10, "D_PRV");
  });
});

test("matches Basilisk AVS dMRP2Omega body-rate vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.D_MRP_TO_OMEGA,
          vectorA: BASILISK_BODY_RATE,
          vectorB: BASILISK_MRP_DERIVATIVE,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_BODY_RATE_FROM_D_MRP, 1e-10, "D_MRP_TO_OMEGA");
  });
});

test("matches Basilisk AVS BdotmatMRP matrix", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.B_DOT_MATRIX_MRP,
          vectorA: BASILISK_BODY_RATE,
          vectorB: [0.015 / D2R, 0.045 / D2R, -0.005 / D2R],
        }),
      ),
    );
    assertMatrixNear(result.MATRIX(), BASILISK_MRP_B_DOT_MATRIX, 1e-10, "B_DOT_MATRIX_MRP");
  });
});

test("matches Basilisk AVS ddMRP second-derivative vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DD_MRP,
          vectorA: BASILISK_BODY_RATE,
          vectorB: BASILISK_MRP_DERIVATIVE,
          vectorC: BASILISK_BODY_RATE_FROM_D_MRP,
          vectorD: BASILISK_BODY_ACCELERATION,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_MRP_SECOND_DERIVATIVE, 1e-10, "DD_MRP");
  });
});

test("matches Basilisk AVS ddMRP2dOmega body-acceleration vector", async (t) => {
  await withHarness(t, async (harness) => {
    const result = decodeResult(
      await invokeRigidBodyKinematics(
        harness,
        encodeRequest({
          operation: rbkOperationCode.DD_MRP_TO_D_OMEGA,
          vectorA: BASILISK_BODY_RATE,
          vectorB: BASILISK_MRP_DERIVATIVE,
          vectorC: BASILISK_MRP_SECOND_DERIVATIVE,
        }),
      ),
    );
    assertVectorNear(result.VECTOR(), BASILISK_BODY_ACCELERATION, 1e-10, "DD_MRP_TO_D_OMEGA");
  });
});
