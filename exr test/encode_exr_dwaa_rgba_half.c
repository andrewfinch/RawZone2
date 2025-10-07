#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// OpenEXR Core C API
#include "openexr.h"

// Minimal C wrapper to encode RGBA HALF scanline EXR with DWAA compression via OpenEXR Core C API.
// pixels: pointer to interleaved RGBA HALF (uint16_t[4]) of size width*height*4
// width/height: image dimensions
// dwa_level: compression level (e.g., 45)
// out_size: returns encoded buffer size in bytes
// Returns: malloc'd pointer to encoded bytes (caller frees via free()) or NULL on error

typedef struct MemSink {
    uint8_t* data;
    size_t size;
    size_t capacity;
} MemSink;

static int64_t grow_and_write(MemSink* s, const void* buf, uint64_t sz, uint64_t off)
{
    if (!s) return -1;
    uint64_t need = off + sz;
    if (need > SIZE_MAX) return -1;
    if (need > s->capacity) {
        size_t newcap = s->capacity ? s->capacity : 65536u;
        while (newcap < need) {
            size_t next = newcap * 2u;
            if (next < newcap) { newcap = (size_t)need; break; }
            newcap = next;
        }
        uint8_t* nd = (uint8_t*)realloc(s->data, newcap);
        if (!nd) return -1;
        s->data = nd;
        s->capacity = newcap;
    }
    memcpy(s->data + (size_t)off, buf, (size_t)sz);
    if (s->size < (size_t)need) s->size = (size_t)need;
    return (int64_t)sz;
}

static int64_t sink_write(
    exr_const_context_t ctxt,
    void* userdata,
    const void* buffer,
    uint64_t sz,
    uint64_t offset,
    exr_stream_error_func_ptr_t error_cb)
{
    (void)ctxt; (void)error_cb;
    return grow_and_write((MemSink*)userdata, buffer, sz, offset);
}

// Exported symbol name predictable for Emscripten
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORTED EMSCRIPTEN_KEEPALIVE
#else
#define EXPORTED
#endif

EXPORTED uint8_t* encode_exr_dwaa_rgba_half(const float* pixels, int width, int height, int dwa_level, int include_alpha, int compression, size_t* out_size)
{
    if (!pixels || width <= 0 || height <= 0 || !out_size) return NULL;

    exr_context_t ctxt = NULL;
    exr_result_t rv;
    uint8_t* outbuf = NULL;
    MemSink sink;
    sink.data = NULL; sink.size = 0; sink.capacity = 0;

    exr_context_initializer_t init = EXR_DEFAULT_CONTEXT_INITIALIZER;
    init.write_fn = &sink_write;
    init.user_data = &sink;
    init.dwa_quality = (float)dwa_level;

    rv = exr_start_write(&ctxt, "mem", EXR_WRITE_FILE_DIRECTLY, &init);
    if (rv != EXR_ERR_SUCCESS) goto fail;

    int part_index = -1;
    rv = exr_add_part(ctxt, "main", EXR_STORAGE_SCANLINE, &part_index);
    if (rv != EXR_ERR_SUCCESS || part_index < 0) goto fail;

    // Part 0 (created above), scanline storage, DWAA compression and RGBA HALF channels
    // Set compression per user selection
    exr_compression_t ctype = (exr_compression_t)(compression);
    if (ctype < EXR_COMPRESSION_NONE || ctype >= EXR_COMPRESSION_LAST_TYPE) ctype = EXR_COMPRESSION_DWAA;
    rv = exr_initialize_required_attr_simple(ctxt, part_index, width, height, ctype);
    if (rv != EXR_ERR_SUCCESS) goto fail;
    (void)exr_set_lineorder(ctxt, part_index, EXR_LINEORDER_INCREASING_Y);
    if (ctype == EXR_COMPRESSION_DWAA || ctype == EXR_COMPRESSION_DWAB) {
        (void)exr_set_dwa_compression_level(ctxt, part_index, (float)dwa_level);
    }

    (void)exr_add_channel(ctxt, part_index, "R", EXR_PIXEL_HALF, EXR_PERCEPTUALLY_LOGARITHMIC, 1, 1);
    (void)exr_add_channel(ctxt, part_index, "G", EXR_PIXEL_HALF, EXR_PERCEPTUALLY_LOGARITHMIC, 1, 1);
    (void)exr_add_channel(ctxt, part_index, "B", EXR_PIXEL_HALF, EXR_PERCEPTUALLY_LOGARITHMIC, 1, 1);
    if (include_alpha) {
        (void)exr_add_channel(ctxt, part_index, "A", EXR_PIXEL_HALF, EXR_PERCEPTUALLY_LINEAR, 1, 1);
    }

    rv = exr_write_header(ctxt);
    if (rv != EXR_ERR_SUCCESS) goto fail;

    int32_t scanlines_per_chunk = 32;
    (void)exr_get_scanlines_per_chunk(ctxt, part_index, &scanlines_per_chunk);
    if (scanlines_per_chunk <= 0) scanlines_per_chunk = 32;

    const int pixel_stride_bytes = (int)(4 * (int)sizeof(float));
    const int line_stride_bytes = (int)(pixel_stride_bytes * (int64_t)width);

    exr_encode_pipeline_t pipe = EXR_ENCODE_PIPELINE_INITIALIZER;

    for (int y0 = 0; y0 < height; y0 += scanlines_per_chunk) {
        exr_chunk_info_t cinfo;
        rv = exr_write_scanline_chunk_info(ctxt, part_index, y0, &cinfo);
        if (rv != EXR_ERR_SUCCESS) goto fail;

        rv = exr_encoding_initialize(ctxt, part_index, &cinfo, &pipe);
        if (rv != EXR_ERR_SUCCESS) goto fail;

        for (int ch = 0; ch < pipe.channel_count; ch++) {
            exr_coding_channel_info_t* ci = &pipe.channels[ch];
            int chan_index = 0;
            if (ci->channel_name && ci->channel_name[0]) {
                char c = ci->channel_name[0];
                chan_index = (c == 'R') ? 0 : (c == 'G') ? 1 : (c == 'B') ? 2 : 3;
            }
            const uint8_t* base = (const uint8_t*)(pixels + ((size_t)y0 * (size_t)width * 4 + (size_t)chan_index));
            ci->encode_from_ptr = base;
            ci->user_bytes_per_element = 4;
            ci->user_data_type = EXR_PIXEL_FLOAT;
            ci->user_pixel_stride = pixel_stride_bytes;
            ci->user_line_stride = line_stride_bytes;
        }

        rv = exr_encoding_choose_default_routines(ctxt, part_index, &pipe);
        if (rv != EXR_ERR_SUCCESS) { exr_encoding_destroy(ctxt, &pipe); goto fail; }

        rv = exr_encoding_run(ctxt, part_index, &pipe);
        exr_encoding_destroy(ctxt, &pipe);
        if (rv != EXR_ERR_SUCCESS) goto fail;
    }

    rv = exr_finish(&ctxt);
    if (rv != EXR_ERR_SUCCESS) goto fail;

    outbuf = (uint8_t*)malloc(sink.size);
    if (!outbuf) goto fail;
    memcpy(outbuf, sink.data, sink.size);
    *out_size = sink.size;

    free(sink.data);
    return outbuf;

fail:
    if (ctxt) { (void)exr_finish(&ctxt); }
    if (sink.data) { free(sink.data); }
    if (outbuf) { free(outbuf); outbuf = NULL; }
    return NULL;
}


