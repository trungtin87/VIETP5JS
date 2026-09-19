/*
 * transpiler.js — Loi cua VietP5 (muc 3.1 trong dac ta SRS)
 * Bo Chuyen Doi 2 Chieu (AST & Lexical Transpiler)
 *
 * PHU THUOC: bien toan cuc `acorn` (nhung qua CDN TRUOC khi nhung file nay)
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/acorn/8.11.3/acorn.min.js"></script>
 *   <script src="transpiler.js"></script>
 *
 * NGUYEN LY:
 *  1) Dung Acorn phan tich ma nguon thanh AST (cay cu phap).
 *  2) Duyet TOAN BO cay, chi xet cac nut co type === 'Identifier'.
 *     -> Chuoi van ban (Literal) va ghi chu (khong nam trong AST) TU DONG
 *        khong bao gio bi dung toi, vi chung khong phai la nut Identifier.
 *  3) Neu ten cua Identifier khop voi mot muc trong tu dien (dic.json)
 *     thi ghi lai vi tri (start, end) can thay the.
 *     Neu KHONG khop (vi du: ten bien/ham nguoi dung tu dat) -> bo qua,
 *     giu nguyen 100% -> tu dong thoa man yeu cau "khong dich ten tu dat".
 *  4) Ap dung toan bo thay the tu CUOI chuoi len DAU de khong bi lech
 *     vi tri (offset) giua cac lan thay.
 *
 * Muc 4 cua SRS (kha nang mo rong): moi thay doi trong dic.json chi can
 * goi lai taiTuDien(...) la co hieu luc ngay, KHONG can sua file nay.
 */

(function (global) {
  'use strict';

  // =========================================================
  // 1) TRANG THAI NOI BO: hai ban do dich 2 chieu, dung xay tu dic.json
  // =========================================================
  let banDoAnhSangViet = new Map(); // "circle" -> "veHinhTron"
  let banDoVietSangAnh = new Map(); // "veHinhTron" -> "circle"
  let duLieuTuDienGoc = null;
  let daTaiTuDien = false;

  function xayDungBanDo(duLieuJson) {
    banDoAnhSangViet = new Map();
    banDoVietSangAnh = new Map();
    const tuDien = (duLieuJson && duLieuJson.tu_dien) || [];
    for (const muc of tuDien) {
      if (!muc.vi) continue; // "de_xuat": "giu_nguyen" -> khong dua vao ban do
      banDoAnhSangViet.set(muc.en, muc.vi);
      banDoVietSangAnh.set(muc.vi, muc.en);
    }
    duLieuTuDienGoc = duLieuJson;
    daTaiTuDien = true;
  }

  /**
   * Tai tu dien tu file dic.json (qua fetch) HOAC nhan truc tiep 1 doi
   * tuong JSON da parse san (huu ich khi nhung tinh vao ung dung).
   */
  async function taiTuDien(nguon) {
    let duLieuJson;
    if (typeof nguon === 'string') {
      const phanHoi = await fetch(nguon);
      if (!phanHoi.ok) {
        throw new Error('Khong the tai dic.json tu: ' + nguon);
      }
      duLieuJson = await phanHoi.json();
    } else if (nguon && typeof nguon === 'object') {
      duLieuJson = nguon;
    } else {
      throw new Error('taiTuDien() can duong dan file hoac doi tuong JSON');
    }
    xayDungBanDo(duLieuJson);
    return thongKeTuDien();
  }

  function thongKeTuDien() {
    return {
      da_tai: daTaiTuDien,
      so_muc_kha_dung: banDoAnhSangViet.size,
      phien_ban_p5js: duLieuTuDienGoc ? duLieuTuDienGoc.phien_ban_p5js : null
    };
  }

  // =========================================================
  // 2) BO DUYET AST TONG QUAT (khong phu thuoc thu vien walker rieng)
  // =========================================================
  const KHOA_BO_QUA = new Set(['type', 'start', 'end', 'loc', 'range', 'parent']);

  function duyetCay(nut, goiKhiGapNut) {
    if (!nut || typeof nut !== 'object') return;

    if (Array.isArray(nut)) {
      for (const phanTu of nut) duyetCay(phanTu, goiKhiGapNut);
      return;
    }

    if (typeof nut.type === 'string') {
      goiKhiGapNut(nut);
    }

    for (const khoa in nut) {
      if (KHOA_BO_QUA.has(khoa)) continue;
      const giaTri = nut[khoa];
      if (giaTri && typeof giaTri === 'object') {
        duyetCay(giaTri, goiKhiGapNut);
      }
    }
  }

  // =========================================================
  // 3) THONG BAO LOI CU PHAP THAN THIEN (tieng Viet)
  // =========================================================
  const BANG_DICH_LOI = [
    [/Unexpected token/i, 'Gap ky tu / token khong hop le'],
    [/Unexpected end of input/i, 'Ma nguon ket thuc dot ngot (co the thieu dau } hoac ))'],
    [/has already been declared/i, 'da duoc khai bao truoc do trong cung pham vi'],
    [/Unexpected identifier/i, 'Gap ten khong hop le o vi tri nay'],
    [/Unterminated string constant/i, 'Chuoi van ban (string) chua duoc dong dau nhay'],
    [/Missing initializer/i, 'Thieu gia tri khoi tao cho khai bao nay'],
  ];

  function dichThongBaoLoi(thongBaoGoc) {
    for (const [mau, vietHoa] of BANG_DICH_LOI) {
      if (mau.test(thongBaoGoc)) return vietHoa;
    }
    return thongBaoGoc; // khong co ban dich rieng -> tra nguyen ban tieng Anh
  }

  // =========================================================
  // 4) HAM DICH LOI CHUNG (VI -> EN hoac EN -> VI)
  // =========================================================
  function dichTheoBanDo(maNguon, banDo) {
    if (!daTaiTuDien) {
      return {
        thanh_cong: false,
        thong_bao: 'Chua tai tu dien. Goi VietP5.taiTuDien("./dic.json") truoc.'
      };
    }

    let cayCuPhap;
    try {
      cayCuPhap = acorn.parse(maNguon, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true,
        ranges: true,
        allowReturnOutsideFunction: true
      });
    } catch (loi) {
      const dong = loi.loc ? loi.loc.line : null;
      const cot = loi.loc ? loi.loc.column + 1 : null;
      return {
        thanh_cong: false,
        dong: dong,
        cot: cot,
        thong_bao: (dong ? `Loi cu phap tai dong ${dong}, cot ${cot}: ` : 'Loi cu phap: ')
          + dichThongBaoLoi(loi.message)
      };
    }

    const danhSachThayThe = [];
    duyetCay(cayCuPhap, (nut) => {
      if (nut.type === 'Identifier' && banDo.has(nut.name)) {
        danhSachThayThe.push({
          batDau: nut.start,
          ketThuc: nut.end,
          tenMoi: banDo.get(nut.name)
        });
      }
    });

    // Loai trung lap (vd: thuoc tinh object dang viet tat {tenBien} khien
    // Acorn dung chung 1 nut cho ca key va value) truoc khi thay the.
    const daThay = new Set();
    const danhSachDaLoc = [];
    for (const tt of danhSachThayThe) {
      const khoa = tt.batDau + '-' + tt.ketThuc;
      if (daThay.has(khoa)) continue;
      daThay.add(khoa);
      danhSachDaLoc.push(tt);
    }

    // Ap dung tu cuoi chuoi len dau de khong lech vi tri
    danhSachDaLoc.sort((a, b) => b.batDau - a.batDau);

    let ketQua = maNguon;
    for (const tt of danhSachDaLoc) {
      ketQua = ketQua.slice(0, tt.batDau) + tt.tenMoi + ketQua.slice(tt.ketThuc);
    }

    return {
      thanh_cong: true,
      ma_ket_qua: ketQua,
      so_tu_da_dich: danhSachDaLoc.length,
      // Danh sach vi tri da thay, sap theo thu tu TANG DAN trong ma nguon GOC.
      // UI dung du lieu nay de tinh lai chinh xac vi tri con tro sau khi dich.
      thay_the: danhSachDaLoc.slice().sort((a, b) => a.batDau - b.batDau)
    };
  }

  function dichVietSangAnh(maNguonTiengViet) {
    return dichTheoBanDo(maNguonTiengViet, banDoVietSangAnh);
  }

  function dichAnhSangViet(maNguonTiengAnh) {
    return dichTheoBanDo(maNguonTiengAnh, banDoAnhSangViet);
  }

  // =========================================================
  // 5) XUAT RA PHAM VI TOAN CUC
  // =========================================================
  global.VietP5 = {
    taiTuDien,
    thongKeTuDien,
    dichVietSangAnh,
    dichAnhSangViet
  };

})(typeof window !== 'undefined' ? window : globalThis);
