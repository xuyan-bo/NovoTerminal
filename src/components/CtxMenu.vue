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
        :class="{ danger: item.danger }"
        @click="select(item)"
      >{{ item.label }}</div>
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
    },
    closeOutside(event) {
      if (!this.$el.contains(event.target)) this.visible = false;
    },
    select(item) {
      this.visible = false;
      this.$emit('select', item);
    },
  },
};
</script>
