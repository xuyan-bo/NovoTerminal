import { PROTOCOLS, getProtocol } from './protocols';

// OS marks — windows/apple/linux icon sources
export const OS_SVG = {
  win: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M426.285714 574.857143v372l-389.714285-53.714286v-318.285714h389.714285z m0-424.571429v376.571429H36.571429V204z m561.142857 424.571429v449.142857l-518.285714-71.428571v-377.714286h518.285714z m0-501.714286v453.714286H469.142857V144.571429z" fill="#1296db"></path></svg>`,
  mac: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M905.714286 694.285714q-22.285714 71.428571-70.285715 142.857143-73.714286 112-146.857142 112-28 0-80-18.285714-49.142857-18.285714-86.285715-18.285714-34.857143 0-81.142857 18.857142-46.285714 19.428571-75.428571 19.428572-86.857143 0-172-148-84-149.142857-84-287.428572 0-130.285714 64.571428-213.714285 64-82.285714 162.285715-82.285715 41.142857 0 101.142857 17.142858 59.428571 17.142857 78.857143 17.142857 25.714286 0 81.714285-19.428572 58.285714-19.428571 98.857143-19.428571 68 0 121.714286 37.142857 29.714286 20.571429 59.428571 57.142857-45.142857 38.285714-65.142857 67.428572-37.142857 53.714286-37.142857 118.285714 0 70.857143 39.428571 127.428571t90.285715 72zM690.857143 24q0 34.857143-16.571429 77.714286-17.142857 42.857143-53.142857 78.857143-30.857143 30.857143-61.714286 41.142857-21.142857 6.285714-59.428571 9.714285 1.714286-85.142857 44.571429-146.857142 42.285714-61.142857 142.857142-84.571429 0.571429 1.714286 1.428572 6.285714t1.428571 6.285715q0 2.285714 0.285715 5.714285t0.285714 5.714286z" fill="currentColor"></path></svg>`,
  linux: `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M525.2 198.3c-8.6 5.6-15.2 13.8-18.9 23.4-3.8 12.4-3.2 25.6 1.5 37.7 3.9 12.7 11.7 23.8 22.2 31.8 5.4 3.8 11.6 6.2 18.2 7 6.6 0.8 13.2-0.3 19.1-3.3 7-3.9 12.6-10 15.9-17.3 3.2-7.4 5-15.3 5.2-23.3 0.7-10.2-0.6-20.4-3.8-30.1-3.5-10.6-10.3-19.7-19.5-25.9-4.7-3-9.9-5-15.4-5.8-5.5-0.8-11.1-0.2-16.3 1.8-2.9 1.2-5.7 2.7-8.3 4.5" fill="#FFFFFF"></path><path d="M810.2 606.5c-5.1-28.3-13.1-56-23.8-82.6-7.3-19.8-17.2-38.6-29.5-55.8-12.4-16.5-28.1-30.4-40.2-47.1-6.4-8.7-11.8-18.4-18.5-26.9-2.7-5.6-5.3-11.2-7.9-16.8-8-17.5-15.3-35.4-24.8-52-1.5-2.6-3.1-5.2-4.6-7.7-1.2-16-2.9-32-3.8-48 0.7-32.1-2-64.3-8.1-95.9-4.2-15.1-10.6-29.6-19-42.8-9.8-15.6-22.4-29.2-37.2-40.1-24.1-17.1-52.9-26.3-82.4-26.4-21.7-0.5-43.2 4.4-62.5 14.4-20.3 11.1-36.7 28.2-47 48.9-9.6 20.9-14.7 43.5-15 66.5-0.8 22.6 1.3 45 2.2 67.6 0.9 23.4 0.4 46.9 2.3 70.3 0.6 7.5 1.5 15 1.5 22.6 0 3.8-0.2 7.6-0.3 11.3l-0.3 0.8c-10.2 17.3-21.5 34-33.8 49.9-8.6 10.9-17.2 21.7-25.9 32.4-11.3 12.7-20.9 26.8-28.5 42-5.1 13.2-9.2 26.8-12.4 40.6l-0.3 1.1c-4.8 15.9-10.8 31.3-18 46.2-0.7 1.4-1.4 2.9-2 4.2-4.3 8.9-8.8 17.8-13.5 26.5l-5.4 10.1c-3.4 6.1-6.4 12.4-9 18.8-1.5 3.9-2.7 7.9-3.4 12-1.3 8.7-0.7 17.5 1.6 25.9 0.5 2.1 1.2 4.2 1.9 6.3 2.2 6.2 4.8 12.3 7.9 18.1 1.4 2.7 2.9 5.3 4.3 8l1.3 1.9c1.4 2.5 2.9 5 4.4 7.4l0.2 0.3c1.7 2.8 3.6 5.5 5.4 8.2l0.3 0.4c1.9 2.6 3.8 5.3 5.8 7.9 7.4 28.9 21 55.8 39.7 79-2.9 5.1-5.5 10.1-8.4 15.1-10.2 14.8-18.6 30.7-25.1 47.4-2.7 8.6-3.4 17.7-1.9 26.6 1.4 9 6 17.1 13 23 4.7 3.6 10.1 6.1 15.8 7.3 5.7 1.2 11.6 1.8 17.5 1.5 22.2-1.7 44.2-6.1 65.4-12.9 12.8-3.4 25.6-6.4 38.6-9 13.5-3.1 27.2-5 41-5.6 3.4 0.1 6.8-0.1 10.1-0.3 9.4 1 18.8 1.4 28.3 1l3.5-0.2c2.4 0.3 4.9 0.4 7.4 0.6 16.6 0.9 33.1 2.6 49.5 5.1 14.4 2.2 28.8 5 43 8.5 21.9 6.6 44.4 11 67.3 12.9 6 0.3 12-0.2 18-1.4 5.9-1.2 11.5-3.8 16.3-7.4 7-5.8 11.6-13.9 13.1-22.9 1.5-8.9 0.8-18-1.9-26.6-6.6-16.7-15.1-32.6-25.5-47.3-3.6-6.1-7-12.4-10.6-18.5 15.5-17.3 29.2-36.3 40.7-56.5 7 0.4 13.9-0.4 20.6-2.6 17.5-5.9 32.7-17.3 43.3-32.5 3.2-4.5 5.7-9.5 7.2-14.8 6.9-10.7 11.6-22.7 13.8-35.3 3.2-20.8 2.7-42.1-1.5-62.7h-0.2z m0 0" fill="#020204"></path><path d="M425.6 323.2c-3.1 4-5.3 8.7-6.4 13.6-1.1 4.9-1.8 10-1.9 15 0.3 10.1-0.5 20.2-2.5 30.1-3.5 10.3-8.8 19.8-15.6 28.3-11.7 14.7-20.9 31.2-27.2 48.8-3.2 10.9-4.3 22.3-3.1 33.7-12.1 17.9-22.6 36.9-31.3 56.7-13.4 29.9-22 61.8-25.5 94.4-4.3 40.1 1.6 80.6 17 117.8 11.3 26.8 28.5 50.8 50.3 70.1 11.2 9.7 23.5 17.9 36.7 24.4 46.7 22.8 101.4 22.3 147.6-1.4 23.1-13.5 44.2-30.2 62.6-49.5 11.9-10.8 22.5-22.9 31.8-36.1 15.5-26.9 24.6-57.1 26.5-88.1 9.6-53.6 3.7-108.8-16.9-159.2-8.1-16.8-18.8-32.2-31.8-45.6a252.5 252.5 0 0 0-20.2-68c-7.2-15.5-15.9-30.3-22.6-46.2-2.7-6.5-5.1-13.1-8.1-19.4-2.9-6.4-6.9-12.3-11.8-17.3-5.3-4.9-11.6-8.6-18.5-10.7-6.9-2.2-14-3.4-21.2-3.6-14.4-0.7-28.9 1.1-43.1 0.6-11.5-0.5-22.8-2.5-34.3-1.8-5.7 0.3-11.4 1.4-16.7 3.5-5.4 2.1-10.1 5.5-13.8 10m4.6-125.1c-5.4 0.4-10.5 2.7-14.4 6.4-3.9 3.7-6.8 8.4-8.4 13.5-2.7 10.4-3.4 21.3-1.9 32 0.2 9.7 1.9 19.4 5.1 28.6 1.8 4.5 4.4 8.7 7.8 12.2 3.4 3.5 7.7 6.1 12.4 7.3 4.5 1.1 9.2 0.9 13.5-0.5 4.3-1.4 8.3-3.8 11.5-7 4.7-4.8 8.1-10.7 9.8-17.1 1.7-6.4 2.5-13.1 2.3-19.8 0-8.3-1.3-16.6-3.8-24.6s-6.8-15.3-12.6-21.4c-2.8-2.9-6-5.4-9.6-7.2-3.7-1.7-7.7-2.6-11.7-2.4m95 0c-8.6 5.6-15.2 13.8-18.9 23.4-3.8 12.4-3.2 25.6 1.5 37.7 3.9 12.7 11.7 23.8 22.2 31.8 5.4 3.8 11.6 6.2 18.2 7 6.6 0.8 13.2-0.3 19.1-3.3 7-3.9 12.6-10 15.9-17.3 3.2-7.4 5-15.3 5.2-23.3 0.7-10.2-0.6-20.4-3.8-30.1-3.5-10.6-10.3-19.7-19.5-25.9-4.7-3-9.9-5-15.4-5.8-5.5-0.8-11.1-0.2-16.3 1.8-2.9 1.2-5.7 2.7-8.3 4.5" fill="#FFFFFF"></path><path d="M544.5 223.6c-3.2 0.2-6.2 1.2-8.9 2.9s-5 4-6.8 6.6c-3.4 5.3-5.3 11.5-5.4 17.9-0.3 4.7 0.4 9.5 1.9 14s4.3 8.5 7.9 11.5c3.8 3.1 8.4 4.9 13.3 5.2 4.9 0.2 9.7-1.1 13.7-3.9 3.2-2.3 5.8-5.2 7.6-8.7 1.8-3.4 2.9-7.2 3.4-11 1-6.8-0.2-13.8-3.2-19.9-3.1-6.2-8.4-10.9-14.8-13.4-2.8-1.1-5.7-1.5-8.7-1.4" fill="#020204"></path><path d="M430.2 198.3c-5.4 0.4-10.5 2.7-14.4 6.4-3.9 3.7-6.8 8.4-8.4 13.5-2.7 10.4-3.4 21.3-1.9 32 0.2 9.7 1.9 19.4 5.1 28.6 1.8 4.6 4.4 8.7 7.8 12.2 3.4 3.5 7.7 6.1 12.4 7.3 4.5 1.1 9.2 0.9 13.5-0.5 4.3-1.4 8.3-3.8 11.5-7 4.7-4.8 8.1-10.7 9.8-17.1 1.7-6.4 2.5-13.1 2.3-19.8 0-8.3-1.3-16.6-3.8-24.6s-6.8-15.3-12.6-21.4c-2.8-2.9-6-5.4-9.6-7.2-3.7-1.7-7.7-2.6-11.7-2.4" fill="#FFFFFF"></path><path d="M417.3 242.8c-1.3 6.7-1 13.7 1.1 20.2 1.6 4.3 4 8.2 7.2 11.5 2 2.2 4.3 4.1 7 5.4 2.7 1.4 5.7 1.8 8.7 1.1 2.7-0.7 5-2.3 6.7-4.5 1.7-2.2 2.9-4.7 3.7-7.3 2.3-7.8 2.1-16.1-0.4-23.9-1.6-5.7-4.7-10.9-9.1-14.8-2.1-1.8-4.7-3.2-7.4-3.9-2.8-0.7-5.7-0.5-8.4 0.7-2.8 1.4-5.1 3.7-6.5 6.5-1.4 2.8-2.3 5.8-2.7 8.9" fill="#020204"></path><path d="M404.6 326.9c0.2 0.9 0.5 1.8 1 2.5 0.9 1.4 2 2.5 3.4 3.4 1.3 0.9 2.6 1.7 3.9 2.5 6.9 4.7 13 10.5 17.9 17.3 6 9.4 13.5 17.8 22 25 6.5 4.5 14.1 7.2 22 7.9 9.2 0.7 18.5-0.4 27.4-3.2 8.2-2.4 16.1-5.8 23.5-10.3 12.7-10.2 26.3-19.2 40.7-26.7 3.4-1.2 6.8-2.1 10-3.6 3.3-1.4 6.1-3.8 7.8-7 1.1-3.2 1.8-6.6 1.9-10 0.5-3.6 1.7-7.1 2.3-10.7 0.8-3.6 0.5-7.3-0.8-10.8-1.4-2.7-3.6-4.9-6.3-6.3-2.7-1.3-5.7-2.1-8.7-2.2-6.1 0.2-12.1 0.8-18 1.8-8 0.7-16-0.3-24 0-9.9 0.3-19.8 2.5-29.8 2.9-11.4 0.6-22.7-1.2-34.1-1.7-4.9-0.3-9.9-0.1-14.8 0.7-4.9 0.7-9.6 2.5-13.7 5.3-3.8 3-7.3 6.2-10.7 9.6-1.8 1.6-3.8 3-5.9 4.1-2.2 1.1-4.5 1.7-7 1.6-1.2-0.2-2.5-0.2-3.7 0-0.7 0.3-1.4 0.7-1.9 1.2l-1.5 1.8c-1 1.5-1.9 3.1-2.6 4.7" fill="#D99A03"></path><path d="M429.7 301.7c-4 2.4-7.9 5-11.8 7.7-2.1 1.3-3.8 3-5.1 5.1-0.7 1.6-1 3.3-0.9 5 0.1 1.7 0.1 3.4 0 5.1-0.1 1.1-0.5 2.3-0.5 3.5 0 0.6 0 1.2 0.2 1.7 0.2 0.6 0.4 1.1 0.8 1.5 0.5 0.5 1.2 0.9 2 1.1 0.7 0.2 1.5 0.3 2.3 0.5 3.5 1 6.7 2.9 9.3 5.4 2.7 2.4 5.1 5.2 8 7.5 8 6 17.7 9.1 27.6 9 9.9-0.2 19.7-1.6 29.2-4.1 7.5-1.6 14.9-3.6 22.1-6.1 11.2-4.2 21.5-10.3 30.4-18.2 3.9-3.8 8-7.2 12.4-10.3 4-2.5 8.7-4.2 12.7-6.6 0.4-0.2 0.7-0.5 1.1-0.7 0.3-0.3 0.6-0.6 0.8-1 0.3-0.7 0.3-1.5 0-2.2-0.2-0.7-0.5-1.3-0.9-1.8-0.5-0.6-1.1-1.2-1.7-1.7-4.6-3.4-10.1-5.3-15.8-5.5-5.8-0.4-11.3 0-16.9-1.1-5.2-1.1-10.3-2.6-15.3-4.4-5.3-1.7-10.7-3-16.3-3.9-13-2.1-26.2-1.8-39.1 1-12.1 2.7-23.8 7.3-34.6 13.5" fill="#604405"></path><path d="M428.4 288.1c-5.8 3.9-11 8.7-15.5 14.1-2.6 3-4.7 6.5-6.1 10.3-0.9 3-1.5 6.1-2 9.2-0.3 1.1-0.5 2.3-0.5 3.5 0 0.6 0.1 1.2 0.3 1.7 0.2 0.6 0.5 1.1 0.9 1.5 0.7 0.7 1.6 1.1 2.6 1.3 0.9 0.2 1.9 0.2 2.9 0.3 4.4 0.7 8.5 2.5 12.1 5.1 3.6 2.5 7 5.4 10.7 7.8 8.4 5 18 7.7 27.8 7.9 9.8 0.2 19.5-0.8 29-2.9 7.6-1.4 15.1-3.5 22.4-6.3 10.9-4.7 21.1-10.8 30.4-18.2 4.3-3.2 8.5-6.6 12.4-10.3 1.3-1.3 2.6-2.6 4-3.8 1.4-1.2 3-2.1 4.7-2.7 2.7-0.7 5.5-0.8 8.3-0.1 2 0.5 4.1 0.7 6.2 0.7 1.1 0 2.1-0.2 3.1-0.5 1-0.4 1.9-1 2.5-1.8 0.9-1.1 1.3-2.4 1.3-3.8s-0.4-2.7-1.1-3.9c-1.5-2.3-3.8-4.1-6.3-5.1-3.5-1.4-7.1-2.5-10.8-3.2-11.3-2.7-22.3-6.7-32.7-11.9-5.2-2.6-10.1-5.4-15.3-8.1-5.2-2.9-10.6-5.4-16.2-7.2-12.9-3.5-26.6-2.9-39.1 1.8-14 4.9-26.5 13.4-36.1 24.7" fill="#F5BD0C"></path><path d="M493.5 272.2c0.7 2.3 4.3 1.9 6.4 2.9 2.1 1 3.3 2.9 5.3 3.1 2.1 0.2 5-0.7 5.3-2.6 0.4-2.6-3.4-4.2-5.8-5.1-3.2-1.5-6.8-1.6-10-0.2-0.7 0.3-1.4 1.2-1.2 1.9z m-34.4-1.2c-2.7-0.9-7.1 3.8-5.8 6.3 0.4 0.7 1.6 1.5 2.4 1.1 0.8-0.4 2.3-3.1 3.6-4 1-0.8 0.8-3.1-0.2-3.4z m0 0" fill="#CD8907"></path><path d="M887.7 829.8c-2 5.2-4.9 10-8.5 14.3-8.4 9-18.6 16.2-29.8 21.2-19 8.8-37.5 18.6-55.5 29.3-11.7 7.8-22.6 16.6-32.7 26.4-8.3 8.7-17.2 16.7-26.6 24.2-9.8 7.2-21.1 12.1-33.1 14-14.7 1.9-29.6-0.4-43.1-6.5-9.7-3.7-18.1-10.2-24-18.8-5-9.2-7.3-19.5-6.8-29.9 0.6-18.3 2.8-36.5 6.6-54.5 2.6-15 5.2-30 6.8-45.1 2.8-27.6 3.1-55.3 1-82.9-0.5-4.6-0.5-9.3 0-13.9 0.6-9.4 8.5-16.6 18-16.5 4.3-0.1 8.6 0.3 12.8 1.1 10 1.2 20 2.9 29.8 5.2 6.1 1.6 12.2 3.8 18.3 5.5 10.2 3 21 3.9 31.6 2.9 11.1-2.6 22.4-4.3 33.8-5.3 4.7 0.2 9.4 1 13.8 2.4 4.6 1.3 8.9 3.6 12.4 6.9 2.5 2.7 4.5 5.8 5.8 9.2 1.9 5.1 3.1 10.4 3.5 15.8 0.2 4.8 0.6 9.6 1.2 14.4 1.7 7.7 5.4 14.9 10.6 20.9 5.3 5.8 11 11.2 17.2 16 5.9 5.2 12.1 10 18.6 14.4 3.1 2.1 6.2 4 9.1 6.3 3 2.2 5.5 5 7.4 8.2 2.4 4.4 3.2 9.5 2 14.4" fill="#F5BD0C"></path><path d="M887.7 829.8c-2 5.2-4.9 10-8.5 14.3-8.4 9-18.6 16.2-29.8 21.2-19 8.8-37.5 18.6-55.5 29.3-11.7 7.8-22.6 16.6-32.7 26.4-8.3 8.7-17.2 16.7-26.6 24.2-9.8 7.2-21.1 12.1-33.1 14-14.7 1.9-29.6-0.4-43.1-6.5-9.7-3.7-18.1-10.2-24-18.8-5-9.2-7.3-19.5-6.8-29.9 0.6-18.3 2.8-36.5 6.6-54.5 2.6-15 5.2-30 6.8-45.1 2.8-27.6 3.1-55.3 1-82.9-0.5-4.6-0.5-9.3 0-13.9 0.6-9.4 8.5-16.6 18-16.5 4.3-0.1 8.6 0.3 12.8 1.1 10 1.2 20 2.9 29.8 5.2 6.1 1.6 12.2 3.8 18.3 5.5 10.2 3 21 3.9 31.6 2.9 11.1-2.6 22.4-4.3 33.8-5.3 4.7 0.2 9.4 1 13.8 2.4 4.6 1.3 8.9 3.6 12.4 6.9 2.5 2.7 4.5 5.8 5.8 9.2 1.9 5.1 3.1 10.4 3.5 15.8 0.2 4.8 0.6 9.6 1.2 14.4 1.7 7.7 5.4 14.9 10.6 20.9 5.3 5.8 11 11.2 17.2 16 5.9 5.2 12.1 10 18.6 14.4 3.1 2.1 6.2 4 9.1 6.3 3 2.2 5.5 5 7.4 8.2 2.4 4.4 3.2 9.5 2 14.4M259.4 676.3c4.9-1.9 10.2-2.4 15.4-1.4 5.2 1 10.1 3.1 14.4 6.1 8.3 6.3 15.5 14.1 21.2 22.8 14.1 19.4 27.6 39.2 39.9 59.8 10 16.7 19.1 33.9 30.6 49.6 7.5 10.2 16 19.7 23.6 29.9 7.9 10 13.9 21.4 17.6 33.5 4.4 16.1 2.6 33.2-4.9 48.1-5.4 10.4-13.5 19.1-23.4 25.1-10 6-21.5 9-33.2 8.7-18.4-2.5-36.2-8.1-52.6-16.6-34.9-13.9-72.8-18.3-108.8-29.1-11.1-3.3-21.9-7.3-33.1-10.3-5-1.2-9.9-2.7-14.7-4.7-4.7-2-8.8-5.4-11.5-9.7-2-3.5-3-7.5-2.9-11.5 0.1-4 0.9-7.9 2.3-11.5 2.7-7.5 7.1-14.2 10-21.6 4.4-12.2 6.1-25.3 5-38.2-0.6-12.9-2.9-25.8-3.6-38.7-0.6-5.8-0.4-11.6 0.6-17.3 1.5-11.4 10.4-20.5 21.9-22.2 5.3-0.9 10.6-1.3 15.9-1 5.3 0.3 10.7 0.3 16 0 5.3-0.3 10.6-1.8 15.3-4.3 4.3-2.6 8.1-6.2 11-10.4 2.9-4.2 5.5-8.5 7.9-13 2.4-4.5 5.1-8.7 8.3-12.7 3-4.1 7.1-7.2 11.8-9.4" fill="#F5BD0C"></path><path d="M259.4 676.4c4.9-1.9 10.2-2.4 15.4-1.4 5.2 1 10.1 3.1 14.4 6.1 8.3 6.3 15.5 14.1 21.2 22.8 14.1 19.4 27.6 39.2 39.9 59.8 10 16.7 19.1 33.9 30.6 49.6 7.5 10.2 16 19.7 23.6 29.9 7.9 10 13.9 21.4 17.6 33.5 4.4 16.1 2.6 33.2-4.9 48.1-5.4 10.4-13.5 19.1-23.4 25.1-10 6-21.5 9-33.2 8.7-18.4-2.5-36.2-8.1-52.6-16.6-34.9-13.9-72.8-18.3-108.8-29.1-11.1-3.3-21.9-7.3-33.1-10.3-5-1.2-9.9-2.7-14.7-4.7-4.7-2-8.8-5.4-11.5-9.7-2-3.5-3-7.5-2.9-11.5 0.1-4 0.9-7.9 2.3-11.5 2.7-7.5 7.1-14.2 10-21.6 4.4-12.2 6.1-25.3 5-38.2-0.6-12.9-2.9-25.7-3.6-38.7-0.6-5.8-0.4-11.6 0.6-17.3 1.5-11.4 10.4-20.5 21.9-22.2 5.3-0.9 10.6-1.3 15.9-1 5.3 0.3 10.7 0.3 16 0 5.3-0.3 10.6-1.8 15.3-4.3 4.3-2.6 8.1-6.2 11-10.4 2.9-4.2 5.5-8.5 7.9-13 2.4-4.5 5.1-8.7 8.3-12.7 3-4.1 7.1-7.3 11.8-9.4" fill="#F5BD0C"></path><path d="M267.1 684.8c4.4-1.7 9.3-2 13.9-0.9s8.9 3.2 12.6 6.2c7.1 6.2 13.1 13.6 17.6 21.9 12 19.4 23.7 39 34.6 59 7.9 15.3 16.8 30.1 26.6 44.2 6.8 9.2 14.6 17.6 21.6 26.6 7.3 8.9 12.8 19 16.2 29.9 4 14.3 2.3 29.6-4.5 42.9-5 9.4-12.5 17.3-21.7 22.6-9.2 5.4-19.8 8-30.4 7.5-16.7-2.6-32.9-7.6-48.2-14.9-30.4-11.1-63.5-12.5-94.7-21.2-11.2-3-22.1-7.1-33.4-9.9-5-1.1-10-2.5-14.8-4.3-4.8-1.8-9-5.2-11.8-9.5-1.8-3.4-2.7-7.2-2.5-11 0.2-3.8 1-7.6 2.4-11.2 2.7-7.1 7-13.6 9.7-20.7 3.8-11 5.1-22.6 3.9-34.2-0.8-11.5-2.9-22.9-3.5-34.5-0.4-5.1-0.2-10.3 0.7-15.4 0.9-5.1 3.3-9.8 6.9-13.6 4.2-3.8 9.4-6.3 15-7 5.6-0.7 11.2-0.7 16.7 0 5.6 0.7 11.2 0.9 16.8 0.8 11 0 21-6.4 25.7-16.4 2.3-4.5 4.3-9.2 5.9-13.9 1.7-4.8 4-9.3 6.7-13.6 2.8-4.3 6.8-7.7 11.5-9.7" fill="#F5BD0C"></path></svg>`,
};

export const OS_NAME = { win: 'Windows', mac: 'macOS', linux: 'Linux' };

/** Reserved default group: always in the tree, not selectable, not deletable */
export const UNGROUPED_ID = 'g-ungrouped';
export const UNGROUPED_NAME = '未分组';

export function isUngroupedGroup(g) {
  return !!(g && (g.id === UNGROUPED_ID || g.id === 'g-default'));
}

export const CATALOG = {
  win: [
    { id: 'rdp', name: 'RDP', desc: 'Windows 远程桌面', defaultPort: PROTOCOLS.rdp.defaultPort, rec: true },
    { id: 'ssh', name: 'SSH', desc: '终端 / 命令行（OpenSSH）', defaultPort: PROTOCOLS.ssh.defaultPort, rec: false },
    { id: 'vnc', name: 'VNC', desc: 'VNC Server 兼容', defaultPort: PROTOCOLS.vnc.defaultPort, rec: false },
  ],
  mac: [
    { id: 'vnc', name: 'VNC 屏幕共享', desc: 'macOS 自带共享', defaultPort: PROTOCOLS.vnc.defaultPort, rec: true },
    { id: 'ssh', name: 'SSH', desc: '终端 / SFTP', defaultPort: PROTOCOLS.ssh.defaultPort, rec: false },
  ],
  linux: [
    { id: 'ssh', name: 'SSH', desc: '终端 / SFTP', defaultPort: PROTOCOLS.ssh.defaultPort, rec: true },
    { id: 'vnc', name: 'VNC', desc: 'x11vnc / TurboVNC', defaultPort: PROTOCOLS.vnc.defaultPort, rec: false },
    { id: 'rdp', name: 'RDP (xrdp)', desc: '需安装 xrdp', defaultPort: PROTOCOLS.rdp.defaultPort, rec: false },
  ],
};

export function methodPillClass(id) {
  const protocol = getProtocol(id);
  return protocol ? protocol.pillClass : '';
}

/** Advanced settings defaults — used when user leaves fields empty / never opens the dialog */
export const ADVANCED_DEFAULTS = {
  rdp: {
    quality: 'auto',
    resolution: 'auto',
    screenMode: 'window',
    monitors: 'single',
    colorDepth: '32',
    clipboard: true,
    drives: false,
    printers: false,
    audio: 'local',
    promptCredentials: false,
    adminSession: false,
    autoReconnect: true,
  },
  ssh: {
    charset: 'UTF-8',
    term: 'xterm-256color',
    keepAlive: 30,
    compression: false,
    authType: 'password',
    privateKeyPath: '',
    proxyJump: '',
    x11Forward: false,
    hostKeyPolicy: 'ask',
  },
  vnc: {
    password: '',
    quality: 'auto',
    compressLevel: 6,
    jpegQuality: 6,
    shared: true,
    viewOnly: false,
    scale: 'fit',
    clipboard: true,
    localCursor: true,
  },
};

/** Form schema for MethodAdvancedDialog — type: select | switch | number | text */
export const ADVANCED_FIELDS = {
  rdp: [
    {
      key: 'quality',
      type: 'select',
      labelKey: 'adv.rdp.quality',
      options: [
        { value: 'auto', labelKey: 'adv.rdp.quality.auto' },
        { value: 'high', labelKey: 'adv.rdp.quality.high' },
        { value: 'balanced', labelKey: 'adv.rdp.quality.balanced' },
        { value: 'low', labelKey: 'adv.rdp.quality.low' },
      ],
    },
    {
      key: 'resolution',
      type: 'select',
      labelKey: 'adv.rdp.resolution',
      options: [
        { value: 'auto', labelKey: 'adv.rdp.resolution.auto' },
        { value: '1024x768', label: '1024 × 768' },
        { value: '1280x800', label: '1280 × 800' },
        { value: '1366x768', label: '1366 × 768' },
        { value: '1600x900', label: '1600 × 900' },
        { value: '1920x1080', label: '1920 × 1080' },
        { value: '2560x1440', label: '2560 × 1440' },
        { value: '3840x2160', label: '3840 × 2160' },
      ],
    },
    {
      key: 'screenMode',
      type: 'select',
      labelKey: 'adv.rdp.screenMode',
      options: [
        { value: 'window', labelKey: 'adv.screenMode.window' },
        { value: 'fullscreen', labelKey: 'adv.screenMode.fullscreen' },
      ],
    },
    {
      key: 'monitors',
      type: 'select',
      labelKey: 'adv.rdp.monitors',
      options: [
        { value: 'single', labelKey: 'adv.rdp.monitors.single' },
        { value: 'multi', labelKey: 'adv.rdp.monitors.multi' },
      ],
    },
    {
      key: 'colorDepth',
      type: 'select',
      labelKey: 'adv.rdp.colorDepth',
      options: [
        { value: 'auto', labelKey: 'adv.auto' },
        { value: '32', label: '32 bit' },
        { value: '24', label: '24 bit' },
        { value: '16', label: '16 bit' },
        { value: '15', label: '15 bit' },
      ],
    },
    {
      key: 'audio',
      type: 'select',
      labelKey: 'adv.rdp.audio',
      options: [
        { value: 'local', labelKey: 'adv.rdp.audio.local' },
        { value: 'remote', labelKey: 'adv.rdp.audio.remote' },
        { value: 'none', labelKey: 'adv.rdp.audio.none' },
      ],
    },
    { key: 'clipboard', type: 'switch', labelKey: 'adv.rdp.clipboard' },
    { key: 'drives', type: 'switch', labelKey: 'adv.rdp.drives' },
    { key: 'printers', type: 'switch', labelKey: 'adv.rdp.printers' },
    { key: 'promptCredentials', type: 'switch', labelKey: 'adv.rdp.promptCredentials' },
    { key: 'adminSession', type: 'switch', labelKey: 'adv.rdp.adminSession' },
    { key: 'autoReconnect', type: 'switch', labelKey: 'adv.rdp.autoReconnect' },
  ],
  ssh: [
    {
      key: 'charset',
      type: 'select',
      labelKey: 'adv.ssh.charset',
      options: [
        { value: 'UTF-8', label: 'UTF-8' },
        { value: 'GBK', label: 'GBK' },
        { value: 'GB2312', label: 'GB2312' },
        { value: 'Big5', label: 'Big5' },
        { value: 'ISO-8859-1', label: 'ISO-8859-1' },
        { value: 'ASCII', label: 'ASCII' },
      ],
    },
    {
      key: 'term',
      type: 'select',
      labelKey: 'adv.ssh.term',
      options: [
        { value: 'xterm-256color', label: 'xterm-256color' },
        { value: 'xterm', label: 'xterm' },
        { value: 'vt100', label: 'vt100' },
        { value: 'linux', label: 'linux' },
        { value: 'ansi', label: 'ansi' },
      ],
    },
    { key: 'keepAlive', type: 'number', labelKey: 'adv.ssh.keepAlive', min: 0, max: 3600, placeholderKey: 'adv.ssh.keepAlivePh' },
    { key: 'compression', type: 'switch', labelKey: 'adv.ssh.compression' },
    {
      key: 'authType',
      type: 'select',
      labelKey: 'adv.ssh.authType',
      options: [
        { value: 'password', labelKey: 'adv.ssh.auth.password' },
        { value: 'publickey', labelKey: 'adv.ssh.auth.publickey' },
      ],
    },
    { key: 'privateKeyPath', type: 'text', labelKey: 'adv.ssh.privateKeyPath', placeholderKey: 'adv.ssh.privateKeyPathPh' },
    { key: 'proxyJump', type: 'text', labelKey: 'adv.ssh.proxyJump', placeholderKey: 'adv.ssh.proxyJumpPh' },
    { key: 'x11Forward', type: 'switch', labelKey: 'adv.ssh.x11Forward' },
    {
      key: 'hostKeyPolicy',
      type: 'select',
      labelKey: 'adv.ssh.hostKeyPolicy',
      options: [
        { value: 'ask', labelKey: 'adv.ssh.hostKey.ask' },
        { value: 'accept-new', labelKey: 'adv.ssh.hostKey.acceptNew' },
        { value: 'strict', labelKey: 'adv.ssh.hostKey.strict' },
      ],
    },
  ],
  vnc: [
    { key: 'password', type: 'password', labelKey: 'adv.vnc.password', placeholderKey: 'adv.vnc.passwordPh' },
    {
      key: 'quality',
      type: 'select',
      labelKey: 'adv.vnc.quality',
      options: [
        { value: 'auto', labelKey: 'adv.rdp.quality.auto' },
        { value: 'high', labelKey: 'adv.rdp.quality.high' },
        { value: 'medium', labelKey: 'adv.vnc.quality.medium' },
        { value: 'low', labelKey: 'adv.rdp.quality.low' },
      ],
    },
    { key: 'compressLevel', type: 'number', labelKey: 'adv.vnc.compressLevel', min: 0, max: 9, placeholderKey: 'adv.vnc.levelPh' },
    { key: 'jpegQuality', type: 'number', labelKey: 'adv.vnc.jpegQuality', min: 0, max: 9, placeholderKey: 'adv.vnc.levelPh' },
    {
      key: 'scale',
      type: 'select',
      labelKey: 'adv.vnc.scale',
      options: [
        { value: 'fit', labelKey: 'adv.vnc.scale.fit' },
        { value: '100', label: '100%' },
        { value: '75', label: '75%' },
        { value: '50', label: '50%' },
        { value: '150', label: '150%' },
        { value: '200', label: '200%' },
      ],
    },
    { key: 'shared', type: 'switch', labelKey: 'adv.vnc.shared' },
    { key: 'viewOnly', type: 'switch', labelKey: 'adv.vnc.viewOnly' },
    { key: 'clipboard', type: 'switch', labelKey: 'adv.vnc.clipboard' },
    { key: 'localCursor', type: 'switch', labelKey: 'adv.vnc.localCursor' },
  ],
};

export function advancedKey(methodId) {
  const id = String(methodId || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(ADVANCED_DEFAULTS, id) ? id : '';
}

/** Merge saved advanced over defaults; blank strings / null fall back to default */
export function resolveAdvanced(methodId, saved) {
  const key = advancedKey(methodId);
  const base = { ...(ADVANCED_DEFAULTS[key] || {}) };
  if (!saved || typeof saved !== 'object') return base;
  const fields = ADVANCED_FIELDS[key] || [];
  fields.forEach((f) => {
    const v = saved[f.key];
    if (v === undefined || v === null) return;
    if (f.type === 'text' && String(v).trim() === '') return;
    if (f.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n) || String(v).trim() === '') return;
      base[f.key] = n;
      return;
    }
    if (f.type === 'switch') {
      base[f.key] = !!v;
      return;
    }
    if (v !== '') base[f.key] = v;
  });
  return base;
}

export function formatTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return '更早';
}

/** xterm.js default ANSI palette (16 colors) — Xshell classic black fallback */
const XTERM_ANSI_DEFAULT = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];

/** Default SSH terminal color scheme — Xshell classic black window */
export const SSH_THEME_DEFAULT = {
  background: '#000000',
  foreground: '#c0c0c0',
  bold: '#ffffff',
  cursor: '#ffffff',
  ansi: XTERM_ANSI_DEFAULT.slice(),
};

/** Merge a saved color scheme over defaults; missing keys fall back to default */
export function resolveSshTheme(saved) {
  const base = {
    background: SSH_THEME_DEFAULT.background,
    foreground: SSH_THEME_DEFAULT.foreground,
    bold: SSH_THEME_DEFAULT.bold,
    cursor: SSH_THEME_DEFAULT.cursor,
    ansi: SSH_THEME_DEFAULT.ansi.slice(),
  };
  if (!saved || typeof saved !== 'object') return base;
  if (typeof saved.background === 'string' && saved.background) base.background = saved.background;
  if (typeof saved.foreground === 'string' && saved.foreground) base.foreground = saved.foreground;
  if (typeof saved.bold === 'string' && saved.bold) base.bold = saved.bold;
  if (typeof saved.cursor === 'string' && saved.cursor) base.cursor = saved.cursor;
  if (Array.isArray(saved.ansi) && saved.ansi.length === 16) {
    base.ansi = saved.ansi.map((c) => (typeof c === 'string' && c ? c : XTERM_ANSI_DEFAULT[0]));
  }
  return base;
}

/** Map a color scheme into xterm.js theme options */
export function sshThemeToXterm(colors) {
  const t = resolveSshTheme(colors);
  const a = t.ansi;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.background,
    selectionBackground: 'rgba(64,158,255,0.35)',
    black: a[0], red: a[1], green: a[2], yellow: a[3],
    blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
    brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  };
}

/** Element async-validator: required with i18n at validate time */
export function requiredRule(t, key, trigger = 'blur') {
  return {
    validator(rule, value, cb) {
      const empty =
        value == null ||
        (typeof value === 'string' && !value.trim()) ||
        (Array.isArray(value) && !value.length);
      if (empty) cb(new Error(t(key)));
      else cb();
    },
    trigger,
  };
}

export function patternRule(t, key, re, trigger = 'blur') {
  return {
    validator(rule, value, cb) {
      const v = String(value == null ? '' : value).trim();
      if (!v) cb(); // required handled separately
      else if (!re.test(v)) cb(new Error(t(key)));
      else cb();
    },
    trigger,
  };
}
