/**
 * dsh-i-hao-hai-pa — 我好害怕 / "I am so scared"
 *
 * 用户对着 DSH 发火时，侧栏上那一组入口（工作台、插件、自动化任务、上下文洞察、更多）
 * 会塌掉。界面其他部分完全不动。
 *
 * 目前提供三种塌法，用控制台切换：
 *   __dshIHHP.mode = 'blocks'   整行坠落，各自翻倒、错开、落在侧栏底部再回来
 *   __dshIHHP.mode = 'pancake'  逐层压塌，从上往下一层压一层，像楼板塌陷
 *   __dshIHHP.mode = 'shards'   切片崩解，每个入口切成几条横片碎掉
 * 默认 'blocks'。
 *
 * 触发：
 *   - 发一句指向 DSH 的气话（自动）
 *   - Cmd/Ctrl + Shift + H（手动预览）
 *   - 控制台 __dshIHHP.play()
 */
window.__ModuleLoader__.load({
  id: 'dsh-i-hao-hai-pa',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-i-hao-hai-pa';
    const TAG = '[' + NS + ']';

    /**
     * 清理历史版本里诊断按钮（?）留下的描边。
     *
     * 旧版本会给元素写内联 `outline`；如果期间元素被 React 重建、或按钮被连点两次，
     * 还原逻辑可能把「高亮态」当成原值写回去，黄框就永久留在界面上。插件加载时
     * 主动扫一遍，只清自己那两个专有颜色，不碰别人的样式。
     */
    function clearLeftoverHighlights() {
      const marks = ['#f5a524', '#e5484d'];
      let cleared = 0;
      try {
        for (const el of Array.from(document.querySelectorAll('[style*="outline"]'))) {
          const css = String(el.getAttribute('style') || '');
          if (!marks.some((mark) => css.includes(mark))) continue;
          el.style.outline = '';
          el.style.outlineOffset = '';
          cleared += 1;
        }
      } catch (error) {
        console.warn(TAG, 'highlight cleanup failed', error);
      }
      return cleared;
    }

    /**
     * 启动时自愈：把上一次演出如果没来得及还原的东西全部复原。
     * 覆盖三类：诊断描边、被临时放开的 overflow、被临时隐藏的原行。
     */
    function healLeftovers() {
      let healed = 0;
      try {
        for (const el of Array.from(document.querySelectorAll('[data-ihhp-prev-overflow]'))) {
          el.style.overflow = el.getAttribute('data-ihhp-prev-overflow') || '';
          el.style.overflowY = el.getAttribute('data-ihhp-prev-overflow-y') || '';
          el.removeAttribute('data-ihhp-prev-overflow');
          el.removeAttribute('data-ihhp-prev-overflow-y');
          healed += 1;
        }
      } catch (error) {
        console.warn(TAG, 'overflow heal failed', error);
      }
      return healed;
    }
    const VERSION = '1.2.3';

    /* ------------------------------------------------------------------ *
     * 名单：先在侧栏里按标签认出这组行，再把它所在容器的所有行都算上
     * ------------------------------------------------------------------ */

    const TARGET_LABELS = [
      '工作台', 'Workbench', 'Workspace',
      '插件', 'Plugins',
      '自动化任务', 'Scheduled tasks', 'Schedules', 'Automations',
      '上下文洞察', 'Context insight', 'Context',
      '更多', 'More',
    ];

    const TIMING = {
      /** 拆出来最多动多少块，防止极端情况下动画数量失控。 */
      maxTargets: 180,
      /** 高于这个高度的元素会被继续拆成更小的块。 */
      brickMaxHeight: 64,
      /** 往下最多拆几层。 */
      maxDepth: 12,
      /** 前震：每个方框高频抖动。 */
      quake: 340,
      /** 相邻两行的前震起跑差，抖得不同步才像地震。 */
      quakeStagger: 32,
      /** 会话块之间的起跑差，比导航行更密。 */
      sessionStagger: 16,
      /** 落地后的余震。 */
      shock: 520,
      crack: 90,
      fall: 520,
      hold: 2000,
      rise: 700,
      /** 等回复重建时，最多等多久（ms）；超时就直接重建，别让界面一直瘫着。 */
      waitReplyMax: 15000,
      stagger: 34,
      shardStagger: 26,
      cooldown: 20000,
      freshness: 8000,
      threshold: 4,
    };

    /** 运行时状态：塌法、本次的停顿、碎片宿主。 */
    const state = { hold: null, host: null, playing: false };
    /** 最近一次演出的目标（仅供调试接口读取，无界面）。 */
    let lastPlan = { targets: [] };

    /** 定稿版没有屏上控件；保留一个空实现，供内部日志调用点复用。 */
    const pill = { show() {} };

    /* ------------------------------------------------------------------ *
     * 定位
     * ------------------------------------------------------------------ */

    function labelOf(el) {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const title = el.getAttribute('title');
      if (title) return title.trim();
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length > 0 && text.length <= 24 ? text : '';
    }

    function rectOf(el) {
      try {
        return el.getBoundingClientRect();
      } catch {
        return null;
      }
    }

    function isRow(el) {
      return el.matches('button, [role="button"], a, [role="link"]');
    }

    /**
     * 真正占位的子元素（供拆块用）：跳过隐藏、fixed 和过小的。
     *
     * `display: contents` 的包裹层自己没有盒子（getBoundingClientRect 全是 0），
     * 但它会把子元素摊进父容器。所以遇到这种层要**原地拆开继续往下找**，
     * 否则父容器会以为“没有子元素”，只能整块掉落。
     */
    function blockChildren(el, out = []) {
      for (const child of Array.from(el.children)) {
        let style;
        try {
          style = getComputedStyle(child);
        } catch {
          continue;
        }
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (style.position === 'fixed') continue;
        if (style.display === 'contents') {
          blockChildren(child, out);
          continue;
        }
        const rect = rectOf(child);
        if (rect === null || rect.width < 6 || rect.height < 6) continue;
        out.push({ el: child, rect });
      }
      return out;
    }

    function rowsIn(container) {
      const rows = [];
      for (const child of Array.from(container.children)) {
        if (!isRow(child)) continue;
        const rect = rectOf(child);
        if (rect === null || rect.width < 8 || rect.height < 8) continue;
        rows.push({ el: child, label: labelOf(child) || '(unnamed)', rect });
      }
      return rows;
    }

    /**
     * 不再枚举任何具体入口。
     *
     * 从侧栏根节点往下走：太矮的元素（一行会话、一个按钮、一条标题）本身就是一块；
     * 太高的容器继续往里拆，直到每块都小到能像积木一样掉。这样侧栏里出现什么就塌
     * 什么——导航行、目录、会话、展开按钮、搜索框、设置……不需要认识它们。
     */
    function findTargets() {
      const targets = [];
      for (const selector of PANEL_ROOTS) {
        const root = document.querySelector(selector);
        if (root === null) continue;
        targets.push(...collectPanel(root));
      }
      return targets;
    }

    /**
     * 参与坍塌的面板根节点：左侧栏、右侧编辑区、中间列（标题栏+标签行+会话区）。
     * `data-dsh-center-col` 是 better-sidebar 给中间列打的标记；没装它时退回
     * 「包含 shell.overlay 的那个外壳列」。
     */
    const PANEL_ROOTS = ['[data-dsh-sidebar-root]', '[data-dsh-better-sidebar]', '[data-dsh-center-col]'];

    function collectPanel(root) {

      const rootRect = root.getBoundingClientRect();
      const bricks = [];
      const seen = new Set();

      const push = (el, rect) => {
        if (seen.has(el)) return;
        if (rect.width < 10 || rect.height < 10) return;
        if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) return;
        seen.add(el);
        bricks.push({ el, label: labelOf(el) || 'row', rect, group: 'auto', host: root });
      };

      const walk = (el, rect, depth) => {
        if (bricks.length >= TIMING.maxTargets) {
          push(el, rect);
          return;
        }

        let display = '';
        try {
          display = getComputedStyle(el).display;
        } catch {
          display = '';
        }

        // display:contents 的包裹层自己没有盒子（rect 会算成 0×0），它只是
        // 把子元素摊进父容器，所以必须直接往下走，否则整段会被当成一块。
        if (display === 'contents') {
          for (const child of Array.from(el.children)) {
            const childRect = rectOf(child);
            const childStyle = (() => {
              try {
                return getComputedStyle(child).display;
              } catch {
                return '';
              }
            })();
            // 自己也是 contents 就继续下潜，否则用它的真实盒子。
            if (childStyle === 'contents') walk(child, rect, depth + 1);
            else if (childRect !== null && childRect.height >= 6) walk(child, childRect, depth + 1);
          }
          return;
        }

        const children = depth >= TIMING.maxDepth ? [] : blockChildren(el);
        const usable = children.filter((child) => child.rect.height >= 8);

        // 拆不拆的判断：
        //  - 超过 200px 的大块一律继续拆，绝不让它整体倾倒；
        //  - 超过 brickMaxHeight 且有两个以上子元素，也继续拆；
        //  - 一行高度通常 24~48px，低于 brickMaxHeight，所以“行”不会被拆散。
        const mustSplit = usable.length > 0 && (rect.height > 200 || rect.height > TIMING.brickMaxHeight);
        if (!mustSplit) {
          push(el, rect);
          return;
        }
        for (const child of usable) walk(child.el, child.rect, depth + 1);
      };

      for (const child of Array.from(root.children)) {
        const rect = rectOf(child);
        if (rect === null) continue;
        walk(child, rect, 0);
      }

      // DOM 顺序 ≠ 视觉顺序（侧栏里有些区域是后渲染的），所以按屏幕纵坐标重排，
      // 波浪才会真的从最上面一行往下走。
      bricks.sort((a, b) => a.rect.top - b.rect.top);
      return bricks;
    }

    /* ------------------------------------------------------------------ *
     * 工具
     * ------------------------------------------------------------------ */

    function randomBetween(min, max) {
      return min + Math.random() * (max - min);
    }

    function clipRectFor(el) {
      let node = el.parentElement;
      while (node !== null) {
        let style;
        try {
          style = getComputedStyle(node);
        } catch {
          return null;
        }
        if (/(hidden|auto|scroll|clip)/.test(`${style.overflowY} ${style.overflow}`)) {
          return node.getBoundingClientRect();
        }
        node = node.parentElement;
      }
      return null;
    }

    function floorFor(targets) {
      const clip = clipRectFor(targets[0].el);
      return clip === null ? window.innerHeight : clip.bottom;
    }

    /**
     * 坍塌后的堆叠方案：把这一整组块按它们原本的上下顺序，从侧栏底部往上摞，
     * 每块只露出上一块的一部分（像瓦砾堆），总高度压进可见范围。
     * 返回 Map<target, dropTo>，dropTo 就是这块要向下位移多少像素。
     */
    function stackPlan(targets, host) {
      const rootRect = host === undefined || host === null ? null : host.getBoundingClientRect();
      const visibleBottom = Math.min(rootRect === null ? window.innerHeight : rootRect.bottom, window.innerHeight) - 12;
      const visibleTop = rootRect === null ? 0 : rootRect.top + 48;

      const ordered = [...targets].sort((a, b) => a.rect.top - b.rect.top);
      const available = Math.max(120, visibleBottom - visibleTop);

      // 每块露出的高度：先按原高度的 60% 摞，堆太高就压缩，最少露 5px 以便还看得出是叠着的。
      let overlap = 0.6;
      let total = 0;
      for (let i = 0; i < ordered.length; i += 1) total += ordered[i].rect.height * overlap;
      if (total > available) {
        const scale = available / total;
        overlap = Math.max(0.12, overlap * scale);
      }

      const plan = new Map();
      let cursor = visibleBottom;
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const target = ordered[index];
        plan.set(target, cursor - target.rect.bottom);
        cursor -= Math.max(5, target.rect.height * overlap);
      }
      return plan;
    }

    /* ------------------------------------------------------------------ *
     * 塌法 A：整行坠落
     * ------------------------------------------------------------------ */

    /**
     * 前震关键帧：一个低频正弦摆动（sway）+ 叠在上面的高频抖动（jitter）。
     * 只有随机抖动会像耳鸣，加上大摆幅的正弦才像地面在左右甩。
     * 旋转与横向位移反向关联，看起来像被甩得站不稳。
     */
    function quakeFrames(count, jitter, sway, cycles, phase) {
      const frames = [];
      const sample = (t) => {
        const theta = phase + t * Math.PI * 2 * cycles;
        const x = Math.sin(theta) * sway + randomBetween(-jitter, jitter);
        const y = randomBetween(-jitter * 0.9, jitter * 0.9) + Math.cos(theta) * jitter * 0.35;
        const r = -x * 0.3 + randomBetween(-jitter * 0.5, jitter * 0.5);
        const scale = 1 + randomBetween(-0.05, 0.05);
        return `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${r.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      };

      for (let index = 0; index < count; index += 1) {
        frames.push({ offset: index / count, transform: sample(index / count), easing: 'linear' });
      }

      const endX = Math.sin(phase + Math.PI * 2 * cycles) * sway;
      const endR = -endX * 0.3;
      const endTransform = `translate3d(${endX.toFixed(2)}px, 0px, 0) rotate(${endR.toFixed(2)}deg)`;
      frames.push({ offset: 1, transform: endTransform, easing: 'linear' });
      return { frames, endTransform };
    }

    /**
     * 把一行克隆到浮层里，位置和尺寸与原位一致。
     *
     * 为什么要克隆：侧栏里有若干会裁剪的滚动容器，直接给原元素加 transform，
     * 一旦越过容器底边就被切掉——上半部分只能掉到「工作区」那条线。克隆件挂在
     * 浮层上（position: fixed），不受侧栏裁剪，可以一路掉到最底部。
     */
    function cloneRow(el, rect) {
      const wrap = document.createElement('div');
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.cssText = [
        'position:fixed',
        `left:${rect.left}px`,
        `top:${rect.top}px`,
        `width:${rect.width}px`,
        `height:${rect.height}px`,
        'pointer-events:none',
        'z-index:2147483000',
        'will-change:transform',
      ].join(';');

      const clone = el.cloneNode(true);
      clone.removeAttribute('id');
      clone.removeAttribute('tabindex');
      clone.style.width = '100%';
      clone.style.height = '100%';
      clone.style.margin = '0';
      clone.style.pointerEvents = 'none';

      wrap.appendChild(clone);
      return wrap;
    }

    /**
     * 临时解除挡在目标外面的裁剪容器（overflow: hidden/auto/scroll）。
     *
     * 上半部分掉不到底，不是动画的问题，是它外面套着一层会裁剪的滚动容器：
     * transform 越界就被切掉。演出期间把这些容器的 overflow 放开，元素就能
     * 一路掉到侧栏底部；结束时按原值还原。
     */
    function unlockClipping(targets) {
      const changed = [];
      const seen = new Set();
      for (const target of targets) {
        let node = target.el.parentElement;
        while (node !== null && node !== document.body) {
          let style;
          try {
            style = getComputedStyle(node);
          } catch {
            break;
          }
          if (!seen.has(node) && /(hidden|auto|scroll|clip)/.test(`${style.overflowY} ${style.overflow}`)) {
            seen.add(node);
            changed.push({ el: node, overflow: node.style.overflow, overflowY: node.style.overflowY });
            // 把原值写在元素自己身上：即使这次演出被打断、清理没跑到，
            // 下次插件加载也能凭标记精确还原，而不是永久留着 overflow: visible。
            node.setAttribute('data-ihhp-prev-overflow', node.style.overflow);
            node.setAttribute('data-ihhp-prev-overflow-y', node.style.overflowY);
            node.style.overflow = 'visible';
            node.style.overflowY = 'visible';
          }
          node = node.parentElement;
        }
      }
      return () => {
        for (const item of changed) {
          item.el.style.overflow = item.overflow;
          item.el.style.overflowY = item.overflowY;
          item.el.removeAttribute('data-ihhp-prev-overflow');
          item.el.removeAttribute('data-ihhp-prev-overflow-y');
        }
      };
    }

    function playBlocks(targets, hold, host) {
      const stack = stackPlan(targets, host);
      const unlock = unlockClipping(targets);
      const animations = [];
      const pieces = [];
      const cloned = [];
      const hidden = [];
      let endsAt = 0;
      const fallSpan = TIMING.fall + TIMING.shock;

      let cursor = 0;
      const step = Math.max(3, Math.min(TIMING.sessionStagger, 700 / Math.max(1, targets.length)));
      targets.forEach((target, index) => {
        try {
          const { el, rect } = target;
          const dropTo = (stack.get(target) ?? (window.innerHeight - rect.bottom)) + randomBetween(-3, 3);
          const drift = randomBetween(-16, 16);
          const spin = randomBetween(-18, 18);
          const startDelay = cursor;
          cursor += step;
          const fallDelay = startDelay + TIMING.quake + (targets.length - 1 - index) * 6;
          const node = el;

          const quake = quakeFrames(14, 5.5, 34, 1.2, index * 1.35 + randomBetween(0, 6.28));
          animations.push(node.animate(quake.frames, {
            duration: TIMING.quake,
            delay: startDelay,
            easing: 'linear',
          }));

          const landed = TIMING.fall / fallSpan;
          const at = (fraction) => (TIMING.fall + TIMING.shock * fraction) / fallSpan;

          const fallen = `translate3d(${drift.toFixed(1)}px, ${dropTo.toFixed(1)}px, 0) rotate(${spin.toFixed(1)}deg)`;
          const tumbleA = `translate3d(${(drift * 0.5).toFixed(1)}px, ${(dropTo * 0.42).toFixed(1)}px, 0) rotate(${(spin * 0.55).toFixed(1)}deg)`;
          const tumbleB = `translate3d(${(drift * 1.35).toFixed(1)}px, ${(dropTo * 0.82).toFixed(1)}px, 0) rotate(${(spin * 1.4).toFixed(1)}deg)`;
          const shockA = `translate3d(${(drift + 9).toFixed(1)}px, ${(dropTo - 6).toFixed(1)}px, 0) rotate(${(spin + 5.5).toFixed(1)}deg)`;
          const shockB = `translate3d(${(drift - 8).toFixed(1)}px, ${(dropTo + 4).toFixed(1)}px, 0) rotate(${(spin - 4.5).toFixed(1)}deg)`;
          const shockC = `translate3d(${(drift + 5).toFixed(1)}px, ${(dropTo - 2.4).toFixed(1)}px, 0) rotate(${(spin + 2.8).toFixed(1)}deg)`;
          const shockD = `translate3d(${(drift - 2.6).toFixed(1)}px, ${(dropTo + 1.2).toFixed(1)}px, 0) rotate(${(spin - 1.4).toFixed(1)}deg)`;

          animations.push(node.animate([
            { offset: 0, transform: quake.endTransform, easing: 'cubic-bezier(.4,0,.86,.44)' },
            { offset: landed * 0.3, transform: tumbleA, easing: 'cubic-bezier(.5,0,.92,.5)' },
            { offset: landed * 0.66, transform: tumbleB, easing: 'cubic-bezier(.45,0,.95,.5)' },
            { offset: landed, transform: fallen, easing: 'linear' },
            { offset: at(0.18), transform: shockA, easing: 'linear' },
            { offset: at(0.36), transform: shockB, easing: 'linear' },
            { offset: at(0.54), transform: shockC, easing: 'linear' },
            { offset: at(0.72), transform: shockD, easing: 'linear' },
            { offset: 1, transform: fallen },
          ], {
            duration: fallSpan,
            delay: fallDelay,
            fill: 'forwards',
          }));

          pieces.push({ node, fallen, riseDelay: (targets.length - 1 - index) * 8 });
          endsAt = Math.max(endsAt, fallDelay + fallSpan);
        } catch (error) {
          console.warn(TAG, 'piece failed', error && error.message);
        }
      });

      /** 重建阶段：把落定的块一条条抬回原位。 */
      const rise = () => {
        const created = [];
        let riseEnd = 0;
        for (const piece of pieces) {
          try {
            created.push(piece.node.animate([
              { offset: 0, transform: piece.fallen, easing: 'cubic-bezier(.2,.7,.3,1.06)' },
              { offset: 1, transform: 'translate3d(0,0,0) rotate(0deg)' },
            ], {
              duration: TIMING.rise,
              delay: piece.riseDelay,
              fill: 'forwards',
            }));
            riseEnd = Math.max(riseEnd, piece.riseDelay + TIMING.rise);
          } catch (error) {
            console.warn(TAG, 'rise failed', error && error.message);
          }
        }
        return { animations: created, endsAt: riseEnd };
      };

      return {
        animations,
        shards: [],
        endsAt,
        rise,
        restore: () => {
          for (const node of cloned) node.remove();
          for (const el of hidden) el.style.visibility = '';
          unlock();
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * 塌法 B：逐层压塌
     * ------------------------------------------------------------------ */

    function playFear(holdOverride, options) {
      if (state.playing) return false;
      if (typeof document === 'undefined' || document.visibilityState === 'hidden') return false;

      let targets = [];
      try {
        targets = findTargets();
      } catch (error) {
        console.warn(TAG, 'target lookup failed', error);
        pill.show(`${VERSION} · 找目标出错：${String(error && error.message).slice(0, 60)}`, 6000);
        return false;
      }
      if (targets.length === 0) {
        pill.show(`${VERSION} · 0 块（没认出面板）`, 3200);
        console.warn(TAG, 'no sidebar rows matched; check __dshIHHP.targets()');
        return false;
      }
      pill.show(`${VERSION} · ${targets.length} 块`, 2600);

      const hold = typeof holdOverride === 'number' ? holdOverride : (typeof state.hold === 'number' ? state.hold : TIMING.hold);
      state.playing = true;
      lastPlan = { targets: targets.map((t) => t.label) };

      let result;
      try {
        // 每个面板（左侧栏、右侧编辑区）各自拆块、各自堆叠，互不干扰。
        const groups = new Map();
        for (const target of targets) {
          const key = target.host === undefined ? null : target.host;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(target);
        }

        const runs = [];
        for (const [hostEl, items] of groups) {
          runs.push(playBlocks(items, hold, hostEl));
        }

        const all = runs.flatMap((run) => run.animations);
        const allShards = runs.flatMap((run) => run.shards);
        const fallEndsAt = Math.max(0, ...runs.map((run) => run.endsAt));

        let finished = false;
        let watchTimer = null;
        let watchdog = null;
        let onHidden = null;
        const cleanup = () => {
          if (finished) return;
          finished = true;
          if (watchTimer !== null) window.clearInterval(watchTimer);
          if (watchdog !== null) window.clearTimeout(watchdog);
          if (onHidden !== null) document.removeEventListener('visibilitychange', onHidden);
          for (const animation of all) {
            try {
              animation.cancel();
            } catch {
              /* gone */
            }
          }
          for (const shard of allShards) shard.remove();
          for (const run of runs) if (typeof run.restore === 'function') run.restore();
          state.playing = false;
        };

        const rebuild = () => {
          if (finished) return;
          let riseEnd = 0;
          for (const run of runs) {
            if (typeof run.rise !== 'function') continue;
            const part = run.rise();
            all.push(...part.animations);
            riseEnd = Math.max(riseEnd, part.endsAt);
          }
          window.setTimeout(cleanup, (riseEnd || 0) + 140);
        };

        // 兜底一：页面被切走（最小化 / 切到别的应用）时立刻收场，别把界面留在瓦砾态。
        onHidden = () => {
          if (document.visibilityState === 'hidden') cleanup();
        };
        document.addEventListener('visibilitychange', onHidden);
        // 兜底二：无论发生什么，60 秒后强制清理，保证不会永久残留。
        watchdog = window.setTimeout(cleanup, 60000);

        const wantReply = options !== undefined && options !== null && options.waitReply === true;
        if (wantReply) {
          // 塌完先瘫着，等 DSH 开始回复（生成中会出现“停止”按钮）再长回来。
          window.setTimeout(() => {
            const started = Date.now();
            // 两条独立信号：生成中的「停止」按钮，或聊天区文字开始变长（流式输出）。
            const column = document.querySelector('[data-dsh-center-col]');
            const baseline = column === null ? 0 : (column.innerText || '').length;
            if (autoDebug) pill.show('等待回复中…（有回复就重建）', 8000);
            watchTimer = window.setInterval(() => {
              let stop = null;
              try {
                stop = document.querySelector('[aria-label*="停止"], [aria-label*="Stop"], [aria-label*="stop"]');
              } catch (error) {
                stop = null;
              }
              let grew = false;
              try {
                if (column !== null && column.isConnected) {
                  grew = (column.innerText || '').length - baseline > 12;
                }
              } catch (error) {
                grew = false;
              }
              if (stop !== null || grew) {
                window.clearInterval(watchTimer);
                watchTimer = null;
                window.setTimeout(rebuild, 260);
                return;
              }
              if (Date.now() - started > TIMING.waitReplyMax) {
                window.clearInterval(watchTimer);
                watchTimer = null;
                rebuild();
              }
            }, 200);
          }, fallEndsAt + 120);
        } else {
          window.setTimeout(rebuild, fallEndsAt + hold);
        }

      } catch (error) {
        console.warn(TAG, 'animation failed', error);
        state.playing = false;
        return false;
      }

      return true;
    }

    /* ------------------------------------------------------------------ *
     * 怒气判断
     * ------------------------------------------------------------------ */

    function numberOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    function readNode(nodes, key) {
      if (nodes === null || nodes === undefined) return undefined;
      if (typeof nodes.get === 'function') return nodes.get(key);
      return nodes[key];
    }

    function lastUserNode(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return null;
      const { nodes, order } = snapshot;
      if (nodes && Array.isArray(order)) {
        for (let index = order.length - 1; index >= 0; index -= 1) {
          const node = readNode(nodes, order[index]);
          if (node && node.kind === 'user') return node;
        }
      }
      return null;
    }

    function contentText(node) {
      const content = node && node.data ? node.data.content : null;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      const parts = [];
      for (const part of content) {
        if (typeof part === 'string') parts.push(part);
        else if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      }
      return parts.join('\n');
    }

    /**
     * 脏话 / 辱骂词表：**命中任意一条即触发**，不再打分。
     *
     * 中文按字符匹配；英文按整词匹配（\b），避免 "ass" 命中 "class" 这类误伤。
     * 这段是纯本地规则，不发请求、不花 token、零延迟。
     */
    const PROFANITY = [
      // —— 中文：人身攻击
      '傻逼', '傻比', '煞笔', '沙雕', '傻B', '傻缺', '二逼', '装逼',
      '智障', '弱智', '脑残', '白痴', '蠢货', '蠢猪', '蠢死', '笨死', '笨蛋', '废物', '废柴',
      '狗东西', '狗东西', '混账', '王八蛋', '混蛋', '神经病', '有病吧',
      // —— 中文：贬损判断
      '垃圾', '狗屎', '放屁', '胡扯', '胡说八道', '扯淡', '鬼扯', '什么玩意',
      '你懂个屁', '没用', '恶心', '离谱',
      // —— 中文：驱赶 / 羞辱
      '滚蛋', '滚开', '闭嘴', '去死', '你瞎', '眼瞎', '听不懂人话', '你是不是傻',
      '人工智障', '服了你', '算什么东西',
      // —— 中文：脏话
      '你他妈', '他妈', '妈的', '卧槽', '我操', '操你', '草泥马', '日了狗', '尼玛',
      // —— 中文：变体写法（b样 / 逼样 / 屌样…），前面不能紧跟英文字母数字，避免误伤 "3b样"
      '(?<![A-Za-z0-9])b样', '这b样', '那b样', '什么b样', '逼样', '屄样', '屌样', '鸟样',
      '傻x', '傻叉', '沙比', '二货', '蠢驴', '猪脑子', '脑子有病', '你是猪', '废物点心',
      '去你的', '有多远滚多远', '滚一边去', '你算老几', '什么破东西',
      // —— English
      '\\bstupid\\b', '\\bidiot\\b', '\\bdumb\\b', '\\bmoron\\b', '\\buseless\\b',
      '\\btrash\\b', '\\bgarbage\\b', '\\bbullshit\\b', '\\bnonsense\\b', '\\bshut up\\b',
      '\\bwtf\\b', '\\bscrew you\\b', '\\bf+u+c+k\\b', '\\bfuck off\\b', '\\bpathetic\\b',
      '\\bworthless\\b', '\\byou suck\\b', '\\bdumbass\\b', '\\bjackass\\b', '\\basshole\\b',
      '\\bdipshit\\b', '\\bcrap\\b', '\\bretard\\b',
    ];

    let PROFANITY_RE = null;
    try {
      PROFANITY_RE = new RegExp(PROFANITY.join('|'), 'i');
    } catch (error) {
      console.warn(TAG, 'profanity regex failed', error);
      PROFANITY_RE = null;
    }

    /** 剥掉代码块、行内代码、引用块和链接——引用别人的脏话不算。 */
    function sanitize(text) {
      return String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/^[ \t]*>[ \t]?.*$/gm, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .trim();
    }

    /** 命中词表即算骂人。超长消息（>400 字）视为在干活，放行。 */
    function isRude(raw) {
      if (PROFANITY_RE === null) return false;
      const text = sanitize(raw);
      if (text.length === 0) return false;
      if (text.length > 400) return false;
      return PROFANITY_RE.test(text);
    }

    /** 调试用：返回命中的那条词（没有就返回 null）。 */
    function matchedWord(raw) {
      if (PROFANITY_RE === null) return null;
      const text = sanitize(raw);
      const found = text.match(PROFANITY_RE);
      return found === null ? null : found[0];
    }

    const seen = { session: null, seq: -1, lastAt: 0, lastText: '' };
    /** 上一次自动触发用的文案与时间：同一句 8 秒内不重复，两次之间受 cooldown 限制。 */
    let lastFiredText = '';
    let lastFiredAt = 0;
    /** 打开后，每次读到用户消息都会把小条当日志用（判断自动触发为什么没生效）。 */
    let autoDebug = false;
    /** 由 apply 里的观察者注入，芯片可以手动触发一次扫描。 */
    let runScan = null;

    function consider(node, sessionId) {
      try {
        if (!node || node.kind !== 'user') return;
        if (sessionId !== seen.session) {
          seen.session = sessionId;
          seen.seq = -1;
        }
        const data = node.data || {};
        const seq = numberOr(data.seq, -1);
        if (seq <= seen.seq) return;
        seen.seq = seq;

        const rawTime = numberOr(data.time, 0);
        // 事件时间可能是秒也可能是毫秒，统一成毫秒再比，否则 8 秒时效永远不通过。
        const time = rawTime > 0 && rawTime < 1e12 ? rawTime * 1000 : rawTime;
        const age = time > 0 ? Date.now() - time : -1;
        if (time > 0 && age > TIMING.freshness) {
          if (autoDebug) pill.show(`自动：消息太旧 Δ${Math.round(age / 1000)}s，跳过`, 4000);
          return;
        }

        const text = contentText(node);
        if (text.trim().length === 0) {
          if (autoDebug) pill.show('自动：读到消息但正文为空', 4000);
          return;
        }

        const now = Date.now();
        const hit = matchedWord(text);
        if (autoDebug) {
          const cooling = now - seen.lastAt < TIMING.cooldown;
          pill.show(
            `自动：Δ${time > 0 ? Math.round(age / 1000) + 's' : '?'} · ${hit === null ? '未命中' : '命中「' + hit + '」'}${cooling ? ' · 冷却中' : ''} · ${text.slice(0, 10)}`,
            4500,
          );
        }
        if (now - seen.lastAt < TIMING.cooldown) {
          seen.lastText = text;
          return;
        }
        seen.lastText = text;
        if (!isRude(text)) return;
        seen.lastAt = now;
        playFear();
      } catch (error) {
        console.warn(TAG, 'anger check failed', error);
      }
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */

    /**
     * 碎片宿主：常驻挂载在 shell.overlay 里，但**不渲染任何可见元素**。
     * 定稿版没有界面控件——触发方式只有两种：发消息时的自动判定，以及双击面板空白处。
     * 这个空容器留着，是为了让切片模式（内部调试用）仍有地方挂克隆件。
     */
    function ShardHost() {
      return h('div', {
        ref: (node) => {
          state.host = node;
        },
        'aria-hidden': 'true',
        style: { position: 'absolute', inset: '0', pointerEvents: 'none' },
      });
    }

    /* ------------------------------------------------------------------ *
     * 插件
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        console.info(TAG, 'loaded ' + VERSION);

        // 清历史残留的黄框（立即 + 稍后再扫两次，防止 React 重渲染后又被写回）。
        clearLeftoverHighlights();
        healLeftovers();
        window.setTimeout(() => {
          clearLeftoverHighlights();
          healLeftovers();
        }, 500);
        window.setTimeout(() => {
          clearLeftoverHighlights();
          healLeftovers();
        }, 2000);
        try {
          window.__dshIHHP = {
            version: VERSION,
            hold: (ms) => {
              state.hold = typeof ms === 'number' ? ms : null;
              return state.hold;
            },
            play: (holdOverride) => playFear(holdOverride),
            targets: () => findTargets().map((target) => target.label),
            last: () => lastPlan,
            rude: (text) => ({ rude: isRude(text), matched: matchedWord(text) }),
          };
        } catch (error) {
          console.warn(TAG, 'debug handle failed', error);
        }

        ctx.effect(() => {
          const stopHost = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-i-hao-hai-pa:shards',
            order: 80,
          }, ShardHost));

          // ── 自动触发：从输入框的发送动作拿原文 ────────────────────────
          // 会话里的消息行找不到稳定类名（试过 _userRow / userRow 都不匹配），
          // 与其继续猜 DOM，不如在“你要发出去的那一刻”直接读输入框——这里的
          // 文字一定是你要说的话，也不依赖任何类名。
          const readComposer = () => {
            const editable = document.querySelector('[contenteditable="true"]');
            if (editable !== null) {
              const text = (editable.innerText || editable.textContent || '').trim();
              if (text !== '') return text;
            }
            const area = document.querySelector('textarea');
            if (area !== null) return String(area.value || '').trim();
            return '';
          };

          const judge = (text, from) => {
           try {
            const now = Date.now();
            const hit = matchedWord(text);
            if (autoDebug) {
              pill.show(
                `发送(${from})：${hit === null ? '未命中' : '命中「' + hit + '」'} · ${text.slice(0, 14)}`,
                20000,
              );
            }
            if (hit === null) return;
            if (text === lastFiredText && now - lastFiredAt < 8000) return;
            if (now - lastFiredAt < TIMING.cooldown) {
              if (autoDebug) pill.show(`发送(${from})：命中但冷却中`, 20000);
              return;
            }
            lastFiredText = text;
            lastFiredAt = now;
            if (autoDebug) pill.show(`发送(${from})：命中「${hit}」→ 播放`, 20000);
            playFear(undefined, { waitReply: true });
           } catch (error) {
            console.warn(TAG, 'judge failed', error);
           }
          };

          const onComposerKey = (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('[contenteditable="true"], textarea') === null) return;
            const text = readComposer();
            if (text === '') return;
            judge(text, '回车');
          };

          const onComposerClick = (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const button = target.closest('button, [role="button"]');
            if (button === null) return;
            const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`;
            if (!/发送|send|submit/i.test(label)) return;
            const text = readComposer();
            if (text === '') return;
            judge(text, '按钮');
          };

          document.addEventListener('keydown', onComposerKey, true);
          document.addEventListener('click', onComposerClick, true);

          // 兼容其他宿主（本机 Desktop 会把 Cmd+Shift 组合键拦掉，所以主要入口是双击空白处）
          const onKeyDown = (event) => {
            if (!(event.metaKey || event.ctrlKey) && !event.altKey) return;
            if (!event.shiftKey) return;
            if (String(event.key).toLowerCase() !== 'h') return;
            event.preventDefault();
            playFear();
          };
          window.addEventListener('keydown', onKeyDown, true);

          // 双击侧栏里那组入口中的任意一个，也能触发——完全不依赖键盘和控制台。
          // 双击只在面板的**空白处**触发。会话行、目录行、按钮、输入框自己的双击
          // （比如重命名）必须原样交还给它们——所以这里既不 preventDefault 也不
          // stopPropagation，遇到可交互元素直接放行。
          const INTERACTIVE = [
            'button',
            'a',
            '[role="button"]',
            '[role="link"]',
            'input',
            'textarea',
            'select',
            '[contenteditable="true"]',
            '[class*="_sessionRow"]',
            '[class*="_projectRow"]',
          ].join(',');

          const onDoubleClick = (event) => {
            const node = event.target;
            if (!(node instanceof Element)) return;
            if (node.closest('[data-dsh-sidebar-root], [data-dsh-better-sidebar]') === null) return;
            if (node.closest(INTERACTIVE) !== null) return;
            playFear();
          };
          document.addEventListener('dblclick', onDoubleClick, true);

          return () => {
            document.removeEventListener('keydown', onComposerKey, true);
            document.removeEventListener('click', onComposerClick, true);
            document.removeEventListener('dblclick', onDoubleClick, true);
            stopHost();
            window.removeEventListener('keydown', onKeyDown, true);
            state.host = null;
          };
        });
      },
    };
  },
});
