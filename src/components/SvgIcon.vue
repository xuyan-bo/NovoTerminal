<template>
  <span class="svg-icon" :style="iconStyle" aria-hidden="true"></span>
</template>

<script>
export default {
  name: 'SvgIcon',
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 14 },
  },
  computed: {
    iconStyle() {
      // relative to the document so it also resolves under file:// (packaged app)
      const url = `url("icons/${this.name}.svg")`;
      const px = typeof this.size === 'number' ? `${this.size}px` : this.size;
      return {
        width: px,
        height: px,
        'mask-image': url,
        'mask-mode': 'luminance',
        'mask-repeat': 'no-repeat',
        'mask-position': 'center',
        'mask-size': 'contain',
        'background-color': 'currentColor',
      };
    },
  },
};
</script>

<style scoped>
.svg-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: middle;
}
</style>
