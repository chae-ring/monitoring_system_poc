
# Host Fault Analysis Demo

Grafana + Prometheus + Node Exporter 기반 모니터링 시스템을 설명하기 위한 Host 단위 장애분석 PoC UI입니다.

## 실행 방법

```bash
npm install
npm run dev
```

브라우저에서 Vite가 출력하는 주소로 접속하면 됩니다. 보통 아래 주소입니다.

```text
http://localhost:5173
```

## 데모 흐름

1. 초기 화면에서 모든 Host가 정상 상태임을 확인합니다.
2. `CPU 장애 시뮬레이션` 버튼을 누릅니다.
3. `compute-02`가 Critical 상태로 올라오는 것을 확인합니다.
4. Top CPU Host, 장애 유형 후보, 상세 근거 그래프를 순서대로 보여줍니다.
5. 발표 멘트: 기존 모니터링은 지표를 사람이 직접 비교해야 하지만, 이 PoC는 이상 Host 선별 → 장애 유형 후보 분류 → 상세 근거 확인 흐름으로 재구성했습니다.

## 현재 범위

- Node Exporter 기반 Host 단위 장애분석 데모
- VM/IP/사용자 단위 추적은 OpenStack API, Flow Log, 추가 exporter 연계가 필요한 확장 단계
