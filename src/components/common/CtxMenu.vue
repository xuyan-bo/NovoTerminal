<template>
  <div
    class="ctx-menu"
    :class="{ show: visible }"
    :style="{ left: x + 'px', top: y + 'px' }"
    :aria-hidden="!visible"
    @click.stop
  >
    <template v-for="(item, index) in items">
      <div v-if="item.sep" :key="index" class="ctx-sep"></div>
      <div v-else-if="item.title" :key="index" class="ctx-title">{{ item.label }}</div>
      <div
        v-else
        :key="index"
        class="ctx-item"
        :class="{ danger: item.danger, disabled: item.disabled }"
        :title="item.disabled ? item.hint || '' : ''"
        @click="select(item)"
      ><i v-if="item.icon" :class="['ctx-icon', item.icon]" aria-hidden="true"></i>{{ item.label }}</div>
    </template>
  </div>
</template>

<script>
export default {
  name: 'CtxMenu',
  data() {
    return { visible: false, items: [], x: 0, y: 0 };
  },
  mounted() {
    document.addEventListener('click', this.closeOutside);
  },
  beforeDestroy() {
    document.removeEventListener('click', this.closeOutside);
  },
  methods: {
    open(event, items) {
      this.items = items;
      this.x = event.clientX;
      this.y = event.clientY;
      this.visible = true;
      // fixed 定位跟随光标，量出实际尺寸后收进视口，避免靠近右/下边缘时菜单溢出点不到
      this.$nextTick(() => {
        const el = this.$el;
        if (!el) return;
        const pad = 4;
        const maxX = window.innerWidth - el.offsetWidth - pad;
        const maxY = window.innerHeight - el.offsetHeight - pad;
        this.x = Math.max(pad, Math.min(event.clientX, maxX));
        this.y = Math.max(pad, Math.min(event.clientY, maxY));
      });
    },
    closeOutside(event) {
      if (!this.$el.contains(event.target)) this.visible = false;
    },
    select(item) {
      this.visible = false;
      if (!item.disabled) this.$emit('select', item);
    },
  },
};
</script>
