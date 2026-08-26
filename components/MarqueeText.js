// MarqueeText
// Single-line text that auto-scrolls horizontally when it doesn't fit its
// container (poster card titles). Static when it fits.

import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';

export default function MarqueeText({ text, style, speed = 25, startDelay = 1400 }) {
  const [boxW, setBoxW] = useState(0);
  const [textW, setTextW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    x.setValue(0);
    if (!boxW || !textW || textW <= boxW + 2) return undefined;
    const dist = textW - boxW;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(startDelay),
        Animated.timing(x, { toValue: -dist, duration: (dist / speed) * 1000, useNativeDriver: true }),
        Animated.delay(900),
        Animated.timing(x, { toValue: 0, duration: 350, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [boxW, textW, text]);

  return (
    <View
      style={{ overflow: 'hidden', flexDirection: 'row' }}
      onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}
    >
      <Animated.Text
        numberOfLines={1}
        ellipsizeMode="clip"
        onLayout={(e) => setTextW(e.nativeEvent.layout.width)}
        style={[style, { flexShrink: 0, transform: [{ translateX: x }] }]}
      >
        {text}
      </Animated.Text>
    </View>
  );
}
