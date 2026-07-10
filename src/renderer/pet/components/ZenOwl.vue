<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import type { PetState } from '@shared/types'

const props = defineProps<{
  state: PetState
}>()

// ── 眨眼控制 ──
const isBlinking = ref(false)
let blinkTimer: ReturnType<typeof setInterval> | null = null

function startBlinking() {
  blinkTimer = setInterval(() => {
    // idle 和 sleeping 状态下不随机眨眼
    if (props.state === 'idle' || props.state === 'listening') {
      isBlinking.value = true
      setTimeout(() => {
        isBlinking.value = false
      }, 150)
    }
  }, 3000 + Math.random() * 2000)
}

function stopBlinking() {
  if (blinkTimer) {
    clearInterval(blinkTimer)
    blinkTimer = null
  }
}

onMounted(startBlinking)
onUnmounted(stopBlinking)

// ── 状态类名 ──
const stateClass = computed(() => `state-${props.state}`)

// ── 眼睛状态 ──
const eyeClass = computed(() => {
  if (props.state === 'sleeping' || isBlinking.value) return 'eyes-closed'
  if (props.state === 'happy') return 'eyes-happy'
  if (props.state === 'confused') return 'eyes-confused'
  if (props.state === 'thinking') return 'eyes-thinking'
  return 'eyes-open'
})
</script>

<template>
  <div class="zen-owl-container" :class="stateClass" data-testid="zen-owl">
    <!-- 进化光晕 -->
    <div class="aura" v-if="state === 'evolving'"></div>

    <!-- 思考气泡 -->
    <div class="thought-bubble" v-if="state === 'thinking'">
      <span class="thought-dot"></span>
      <span class="thought-dot"></span>
      <span class="thought-dot"></span>
    </div>

    <!-- 睡眠 Zzz -->
    <div class="sleep-zzz" v-if="state === 'sleeping'">
      <span class="z">z</span>
      <span class="z">z</span>
      <span class="z">z</span>
    </div>

    <!-- 开心星星 -->
    <div class="happy-stars" v-if="state === 'happy'">
      <span class="star" style="--d: 0s">✦</span>
      <span class="star" style="--d: 0.2s">✦</span>
      <span class="star" style="--d: 0.4s">✦</span>
    </div>

    <!-- 困惑标记 -->
    <div class="confused-mark" v-if="state === 'confused'">?</div>

    <svg
      class="zen-owl"
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
    >
      <!-- ═══ 耳簇 ═══ -->
      <g class="tufts">
        <path
          class="tuft tuft-left"
          d="M 58 62 Q 48 35 62 48 Q 58 42 58 62 Z"
        />
        <path
          class="tuft tuft-right"
          d="M 142 62 Q 152 35 138 48 Q 142 42 142 62 Z"
        />
      </g>

      <!-- ═══ 身体 ═══ -->
      <ellipse class="body" cx="100" cy="118" rx="58" ry="62" />

      <!-- ═══ 腹部 ═══ -->
      <ellipse class="belly" cx="100" cy="128" rx="36" ry="42" />

      <!-- 腹部羽毛纹理 -->
      <g class="belly-feathers">
        <path d="M 85 115 Q 100 125 115 115" class="feather-line" />
        <path d="M 82 130 Q 100 142 118 130" class="feather-line" />
        <path d="M 85 145 Q 100 155 115 145" class="feather-line" />
      </g>

      <!-- ═══ 翅膀 ═══ -->
      <ellipse
        class="wing wing-left"
        cx="52"
        cy="122"
        rx="14"
        ry="32"
        transform="rotate(12 52 122)"
      />
      <ellipse
        class="wing wing-right"
        cx="148"
        cy="122"
        rx="14"
        ry="32"
        transform="rotate(-12 148 122)"
      />

      <!-- ═══ 眼窝（白色大圆） ═══ -->
      <circle class="eye-socket eye-socket-left" cx="80" cy="92" r="23" />
      <circle class="eye-socket eye-socket-right" cx="120" cy="92" r="23" />

      <!-- ═══ 眼睛（琥珀色瞳孔） ═══ -->
      <g class="eyes" :class="eyeClass">
        <!-- 左眼 -->
        <g class="eye eye-left">
          <circle class="pupil" cx="80" cy="92" r="13" />
          <circle class="pupil-inner" cx="80" cy="92" r="8" />
          <circle class="highlight highlight-main" cx="84" cy="88" r="4" />
          <circle class="highlight highlight-small" cx="76" cy="96" r="2" />
        </g>

        <!-- 右眼 -->
        <g class="eye eye-right">
          <circle class="pupil" cx="120" cy="92" r="13" />
          <circle class="pupil-inner" cx="120" cy="92" r="8" />
          <circle class="highlight highlight-main" cx="124" cy="88" r="4" />
          <circle class="highlight highlight-small" cx="116" cy="96" r="2" />
        </g>
      </g>

      <!-- 闭眼线条（sleeping/blink 时显示） -->
      <g class="eyes-closed-lines" v-if="eyeClass === 'eyes-closed'">
        <path class="eye-closed-line" d="M 70 92 Q 80 96 90 92" />
        <path class="eye-closed-line" d="M 110 92 Q 120 96 130 92" />
      </g>

      <!-- 开心眼线 (^ ^) -->
      <g class="eyes-happy-lines" v-if="eyeClass === 'eyes-happy'">
        <path class="eye-happy-line" d="M 70 92 Q 80 84 90 92" />
        <path class="eye-happy-line" d="M 110 92 Q 120 84 130 92" />
      </g>

      <!-- ═══ 喙 ═══ -->
      <path
        class="beak"
        d="M 100 103 L 93 112 Q 100 117 107 112 Z"
      />

      <!-- ═══ 脸颊红晕（happy 时显示） ═══ -->
      <circle class="blush blush-left" cx="62" cy="108" r="6" v-if="state === 'happy'" />
      <circle class="blush blush-right" cx="138" cy="108" r="6" v-if="state === 'happy'" />

      <!-- ═══ 爪子 ═══ -->
      <g class="feet">
        <path class="foot foot-left" d="M 88 175 L 84 182 M 88 175 L 88 183 M 88 175 L 92 182" />
        <path class="foot foot-right" d="M 112 175 L 108 182 M 112 175 L 112 183 M 112 175 L 116 182" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.zen-owl-container {
  position: relative;
  width: 160px;
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  -webkit-user-select: none;
  cursor: pointer;
}

.zen-owl {
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.25));
}

/* ═══ 颜色定义 ═══ */
.body {
  fill: #3A3A42;
}

.belly {
  fill: #E8E4DD;
}

.feather-line {
  fill: none;
  stroke: #D0CCC4;
  stroke-width: 1.5;
  stroke-linecap: round;
  opacity: 0.6;
}

.tuft {
  fill: #3A3A42;
}

.wing {
  fill: #2E2E35;
}

.eye-socket {
  fill: #E8E4DD;
}

.pupil {
  fill: #F5A623;
  transition: all 0.3s ease;
}

.pupil-inner {
  fill: #1A1A1A;
  transition: all 0.3s ease;
}

.highlight {
  fill: #FFFFFF;
}

.beak {
  fill: #E8A030;
  stroke: #C88820;
  stroke-width: 0.5;
}

.foot {
  fill: none;
  stroke: #E8A030;
  stroke-width: 2.5;
  stroke-linecap: round;
}

.blush {
  fill: #FF9999;
  opacity: 0.5;
}

.eye-closed-line,
.eye-happy-line {
  fill: none;
  stroke: #3A3A42;
  stroke-width: 3;
  stroke-linecap: round;
}

/* ═══ 状态动画 ═══ */

/* — idle: 缓慢呼吸 — */
.state-idle .zen-owl {
  animation: breathe 4s ease-in-out infinite;
}

@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.03); }
}

/* — listening: 轻微摇摆 — */
.state-listening .zen-owl {
  animation: sway 2s ease-in-out infinite;
}

.state-listening .tuft-left {
  animation: ear-perk-left 0.4s ease forwards;
}

.state-listening .tuft-right {
  animation: ear-perk-right 0.4s ease forwards;
}

@keyframes sway {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(2deg); }
  75% { transform: rotate(-2deg); }
}

@keyframes ear-perk-left {
  to { transform: translateY(-3px) rotate(-5deg); }
}

@keyframes ear-perk-right {
  to { transform: translateY(-3px) rotate(5deg); }
}

/* — thinking: 歪头 — */
.state-thinking .zen-owl {
  animation: tilt 3s ease-in-out infinite;
}

@keyframes tilt {
  0%, 100% { transform: rotate(0deg); }
  30% { transform: rotate(-8deg) translateY(-2px); }
  70% { transform: rotate(-8deg) translateY(-2px); }
}

/* 思考气泡 */
.thought-bubble {
  position: absolute;
  top: 5px;
  right: 15px;
  display: flex;
  gap: 4px;
  align-items: center;
}

.thought-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5BAA8A;
  animation: thought-bounce 1.4s ease-in-out infinite;
}

.thought-dot:nth-child(2) { animation-delay: 0.2s; }
.thought-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes thought-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* — working: 翅膀抖动 — */
.state-working .wing-left {
  animation: wing-flap-left 0.4s ease-in-out infinite;
}

.state-working .wing-right {
  animation: wing-flap-right 0.4s ease-in-out infinite;
}

@keyframes wing-flap-left {
  0%, 100% { transform: rotate(12 52 122); }
  50% { transform: rotate(25 52 122) translateX(-3px); }
}

@keyframes wing-flap-right {
  0%, 100% { transform: rotate(-12 148 122); }
  50% { transform: rotate(-25 148 122) translateX(3px); }
}

/* — happy: 跳跃 — */
.state-happy .zen-owl {
  animation: bounce 0.6s ease-in-out infinite;
}

@keyframes bounce {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-8px) scale(1.05); }
}

.happy-stars {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.star {
  position: absolute;
  font-size: 14px;
  color: #F5A623;
  animation: star-fly 1s ease-out infinite;
  animation-delay: var(--d);
}

.star:nth-child(1) { top: 20%; left: 15%; }
.star:nth-child(2) { top: 10%; right: 20%; }
.star:nth-child(3) { top: 30%; left: 70%; }

@keyframes star-fly {
  0% { transform: translateY(0) scale(0); opacity: 0; }
  50% { transform: translateY(-15px) scale(1); opacity: 1; }
  100% { transform: translateY(-30px) scale(0.5); opacity: 0; }
}

/* — confused: 左右歪头 — */
.state-confused .zen-owl {
  animation: confused-tilt 1.5s ease-in-out infinite;
}

@keyframes confused-tilt {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(8deg); }
  75% { transform: rotate(-8deg); }
}

.confused-mark {
  position: absolute;
  top: 0;
  right: 25%;
  font-size: 20px;
  font-weight: bold;
  color: #F5A623;
  animation: confused-pulse 1s ease-in-out infinite;
}

@keyframes confused-pulse {
  0%, 100% { transform: scale(1); opacity: 0.7; }
  50% { transform: scale(1.2); opacity: 1; }
}

/* — sleeping: 上下起伏 — */
.state-sleeping .zen-owl {
  animation: sleep-breathe 4s ease-in-out infinite;
}

@keyframes sleep-breathe {
  0%, 100% { transform: scale(1) translateY(0); }
  50% { transform: scale(1.04) translateY(-2px); }
}

.sleep-zzz {
  position: absolute;
  top: 10px;
  right: 20px;
  display: flex;
  gap: 2px;
}

.sleep-zzz .z {
  font-size: 14px;
  color: #8a8a8a;
  font-style: italic;
  font-weight: bold;
  animation: zzz-float 2s ease-in-out infinite;
}

.sleep-zzz .z:nth-child(2) { animation-delay: 0.3s; font-size: 16px; }
.sleep-zzz .z:nth-child(3) { animation-delay: 0.6s; font-size: 18px; }

@keyframes zzz-float {
  0% { transform: translateY(0) scale(0.8); opacity: 0; }
  50% { transform: translateY(-10px) scale(1); opacity: 0.8; }
  100% { transform: translateY(-20px) scale(1.2); opacity: 0; }
}

/* — evolving: 光晕脉冲 — */
.state-evolving .zen-owl {
  animation: evolve-pulse 2s ease-in-out infinite;
}

.aura {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(91, 170, 138, 0.3) 0%, transparent 70%);
  animation: aura-pulse 2s ease-in-out infinite;
}

@keyframes aura-pulse {
  0%, 100% { transform: scale(1); opacity: 0.5; }
  50% { transform: scale(1.15); opacity: 0.8; }
}

@keyframes evolve-pulse {
  0%, 100% { transform: scale(1); filter: drop-shadow(0 4px 12px rgba(91, 170, 138, 0.4)); }
  50% { transform: scale(1.05); filter: drop-shadow(0 4px 16px rgba(91, 170, 138, 0.7)); }
}

/* ═══ 眼睛状态 ═══ */
.eyes-open .pupil { display: block; }
.eyes-open .pupil-inner { display: block; }
.eyes-open .highlight { display: block; }

.eyes-closed .pupil,
.eyes-closed .pupil-inner,
.eyes-closed .highlight {
  display: none;
}

.eyes-happy .pupil,
.eyes-happy .pupil-inner,
.eyes-happy .highlight {
  display: none;
}

.eyes-confused .eye-left .pupil { transform: translateX(-3px); }
.eyes-confused .eye-right .pupil { transform: translateX(3px); }

.eyes-thinking .eye-left .pupil { transform: translate(-2px, -3px); }
.eyes-thinking .eye-right .pupil { transform: translate(-2px, -3px); }
</style>
