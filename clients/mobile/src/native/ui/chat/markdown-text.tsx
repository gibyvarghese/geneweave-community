/**
 * markdown-text.tsx — renders the progressive markdown-lite blocks from
 * {@link parseMarkdown} as themed React Native text.
 *
 * Device-gated. Pure presentation: it never parses or streams — it takes the
 * already-tokenized blocks (or raw source) and maps each block/inline span to a
 * themed `<Text>`. Safe to render on every streamed delta because the tokenizer
 * is cheap and never throws on partial input.
 */
import { Text, View } from 'react-native';
import { parseMarkdown, type InlineSpan, type MarkdownBlock } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';

function Inline({ spans }: { spans: InlineSpan[] }) {
  const { theme } = useTheme();
  return (
    <>
      {spans.map((s, i) => (
        <Text
          key={i}
          style={{
            fontFamily: s.code ? theme.typography.families.mono : theme.typography.families.body,
            fontWeight: s.bold ? '700' : '400',
            fontStyle: s.italic ? 'italic' : 'normal',
            ...(s.code
              ? { backgroundColor: theme.colors.surfaceElevated, fontSize: theme.typography.scale.mono.fontSize }
              : null),
          }}
        >
          {s.text}
        </Text>
      ))}
    </>
  );
}

export function MarkdownText({ source }: { source: string }) {
  const { theme } = useTheme();
  const blocks: MarkdownBlock[] = parseMarkdown(source);
  const body = theme.typography.scale.body;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {blocks.map((b, i) => {
        if (b.type === 'code') {
          return (
            <View
              key={i}
              style={{
                backgroundColor: theme.colors.surfaceElevated,
                borderRadius: theme.radii.sm,
                padding: theme.spacing.md,
              }}
            >
              <Text
                style={{
                  fontFamily: theme.typography.families.mono,
                  fontSize: theme.typography.scale.mono.fontSize,
                  lineHeight: theme.typography.scale.mono.lineHeight,
                  color: theme.colors.text,
                }}
              >
                {b.text}
              </Text>
            </View>
          );
        }
        if (b.type === 'heading') {
          const scale =
            b.level === 1 ? theme.typography.scale.title : theme.typography.scale.headline;
          return (
            <Text
              key={i}
              style={{
                fontFamily: theme.typography.families.display,
                fontSize: scale.fontSize,
                lineHeight: scale.lineHeight,
                fontWeight: '600',
                color: theme.colors.text,
              }}
            >
              <Inline spans={b.spans} />
            </Text>
          );
        }
        if (b.type === 'bullet') {
          return (
            <View key={i} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Text style={{ color: theme.colors.textSecondary, fontSize: body.fontSize, lineHeight: body.lineHeight }}>
                {'\u2022'}
              </Text>
              <Text style={{ flex: 1, color: theme.colors.text, fontSize: body.fontSize, lineHeight: body.lineHeight }}>
                <Inline spans={b.spans} />
              </Text>
            </View>
          );
        }
        // paragraph
        return (
          <Text
            key={i}
            style={{ color: theme.colors.text, fontSize: body.fontSize, lineHeight: body.lineHeight }}
          >
            <Inline spans={b.spans} />
          </Text>
        );
      })}
    </View>
  );
}
