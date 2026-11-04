#!/bin/sh
# Generates throwaway brand-kit assets for testing (run inside the media-worker container).
#   sh make-test-brand-assets.sh /tmp/brand
set -e
OUT="${1:-/tmp/brand}"; mkdir -p "$OUT"; cd "$OUT"
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

# Intro: 16:9 (tests fit-to-9:16), 2 s, with a tone.
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x6941f5:s=1280x720:r=30:d=2" -f lavfi -i "sine=f=660:d=2" \
  -vf "drawtext=fontfile=$FONT:text='INTRO':fontsize=140:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest intro.mp4

# Outro: vertical, 2 s, no audio track at all (tests silent-part handling).
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x111111:s=720x1280:r=25:d=2" \
  -vf "drawtext=fontfile=$FONT:text='FOLLOW':fontsize=110:fontcolor=0xFFE14D:x=(w-tw)/2:y=(h-th)/2" \
  -c:v libx264 -pix_fmt yuv420p -an outro.mp4

# Music: 20 s of a simple repeating melody (loops/trims are exercised by longer clips).
ffmpeg -loglevel error -y \
  -f lavfi -i "sine=f=523:d=0.5" -f lavfi -i "sine=f=659:d=0.5" -f lavfi -i "sine=f=784:d=0.5" -f lavfi -i "sine=f=659:d=0.5" \
  -filter_complex "[0][1][2][3]concat=n=4:v=0:a=1,aloop=loop=9:size=88200,volume=0.6" -t 20 -c:a libmp3lame -b:a 128k music.mp3

# Logo: opaque yellow badge with text on a transparent background (alpha set explicitly with geq;
# drawbox does not write alpha).
ffmpeg -loglevel error -y -f lavfi -i "color=c=0xFFE14D:s=480x200,format=rgba"   -vf "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(X,40,440)*between(Y,20,180),255,0)',drawtext=fontfile=$FONT:text='MY BRAND':fontsize=58:fontcolor=black:x=(w-tw)/2:y=(h-th)/2"   -frames:v 1 logo.png

ls -la "$OUT"
