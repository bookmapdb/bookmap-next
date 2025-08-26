// next.config.js
/** @type {import('next').NextConfig} */
/*
  초보자용 가이드:
  - 이 파일은 Next.js 전역 설정입니다.
  - 프로덕션(배포)에서는 검색엔진 색인 허용(index,follow),
    프리뷰/개발에서는 색인 금지(noindex)를 자동으로 헤더에 넣습니다.
  - 기본 보안 헤더도 함께 추가합니다.
*/

const isProd =
  process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

const nextConfig = {
  // ✅ 기존 설정 유지(빌드 중 ESLint/TS 오류로 배포가 막히지 않게)
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },

  // ✅ 권장: 보안/정보 노출 최소화
  poweredByHeader: false, // X-Powered-By: Next.js 제거
  compress: true,         // gzip 압축

  // ✅ 페이지 공통 헤더 (SEO + 보안)
  async headers() {
    return [
      {
        // 모든 경로에 공통 적용
        source: "/(.*)",
        headers: [
          // ── SEO: 환경별 로봇 색인 정책
          {
            key: "X-Robots-Tag",
            value: isProd ? "index,follow" : "noindex, nofollow, noarchive",
          },

          // ── Security: 안전한 기본값
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // 필수 권한만 허용 (필요 시 값 수정)
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
          // HSTS: HTTPS 강제(커스텀 도메인/프록시 환경이면 유지 권장)
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },

      // (선택) 정적 파일 캐시 최적화 — public/robots.txt, sitemap.xml
      {
        source: "/robots.txt",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, must-revalidate" }],
      },
      {
        source: "/sitemap.xml",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, must-revalidate" }],
      },
    ];
  },

  // (선택) 엄격 모드 켜기 — 개발 시 렌더링 검사 강화
  // reactStrictMode: true,
};

module.exports = nextConfig;
