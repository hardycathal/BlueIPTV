const QUALITY_PATTERNS = [
  { label: '4K', rank: 40, regex: /\b(4K|UHD|2160P)\b/i },
  { label: 'FHD', rank: 30, regex: /\b(FHD|FULL\s*HD|1080P)\b/i },
  { label: 'HD', rank: 20, regex: /\b(HD|720P)\b/i },
  { label: 'SD', rank: 10, regex: /\b(SD|576P|480P)\b/i },
];

function cleanSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function detectLiveQuality(name) {
  const text = String(name || '');
  return QUALITY_PATTERNS.find((quality) => quality.regex.test(text)) || { label: 'SD', rank: 10 };
}

export function baseLiveChannelName(name) {
  let text = cleanSpaces(name)
    .replace(/\[[^\]]*\b(4K|UHD|2160P|FHD|FULL\s*HD|1080P|HD|720P|SD|576P|480P)\b[^\]]*\]/gi, ' ')
    .replace(/\([^)]*\b(4K|UHD|2160P|FHD|FULL\s*HD|1080P|HD|720P|SD|576P|480P)\b[^)]*\)/gi, ' ')
    .replace(/(?:^|[\s|:._-])(?:4K|UHD|2160P|FHD|FULL\s*HD|1080P|HD|720P|SD|576P|480P)(?=$|[\s|:._-])/gi, ' ');

  text = cleanSpaces(text.replace(/\s*[-|:._]\s*$/g, ''));
  return text || cleanSpaces(name);
}

export function liveChannelGroupKey(channel) {
  return `${channel.category_id || ''}:${baseLiveChannelName(channel.name).toLowerCase()}`;
}

export function groupLiveChannels(channels) {
  const groups = new Map();

  for (const channel of channels || []) {
    const quality = detectLiveQuality(channel.name);
    const baseName = baseLiveChannelName(channel.name);
    const variant = {
      stream_id: channel.stream_id,
      name: channel.name,
      quality: quality.label,
      qualityRank: quality.rank,
      direct_url: channel.direct_url || null,
    };
    const key = liveChannelGroupKey(channel);

    if (!groups.has(key)) {
      groups.set(key, {
        ...channel,
        name: baseName,
        group_name: baseName,
        variant_count: 0,
        variants: [],
      });
    }

    const group = groups.get(key);
    group.variants.push(variant);
    group.variant_count = group.variants.length;
    if (!group.stream_icon && channel.stream_icon) group.stream_icon = channel.stream_icon;
    if (!group.epg_channel_id && channel.epg_channel_id) group.epg_channel_id = channel.epg_channel_id;
  }

  return Array.from(groups.values()).map((group) => {
    group.variants.sort((a, b) => b.qualityRank - a.qualityRank || a.name.localeCompare(b.name));
    const preferred = group.variants[0];
    return {
      ...group,
      stream_id: preferred.stream_id,
      current_quality: preferred.quality,
    };
  });
}
